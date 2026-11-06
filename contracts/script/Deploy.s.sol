// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {AfterbellHook, AFTERBELL_HOOK_FLAGS} from "../src/AfterbellHook.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {NaiveLiquidator} from "../src/mocks/NaiveLiquidator.sol";
import {PoolSeeder} from "../src/mocks/PoolSeeder.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Deploys MockNVDAx, RiskParams, AfterbellHook (at a mined CREATE2 address), the vault, NaiveLiquidator,
///         PoolSeeder and a PoolSwapTest router; seeds the vault (inflation guard) and starts HyperCore account
///         activation; writes deployments/<NETWORK>.json.
/// Flip the deployer into big-block mode first (see README): the vault exceeds the 3M small-block cap.
///
///   NETWORK=testnet forge script script/Deploy.s.sol --rpc-url hyperevm_testnet --broadcast --slow
///
/// The deployer needs SEED_DEPOSIT + nothing else in USDC; CORE_ACTIVATION comes out of the seed.
/// Then wait for `coreUserExists(vault)` before funding margin (README, "After deploy").
/// Testnet's CoreDepositWallet never credits HyperCore (spike 2a/2b), so there CORE_ACTIVATION defaults to 0 and
/// the vault is funded with a HyperCore-side send instead.
contract Deploy is Script {
    struct Config {
        string network;
        address usdc;
        address depositWallet;
        address morpho;
        address poolManager;
        address nvdax; // 0 → deploy MockNVDAx
        uint32 perpAsset;
        uint32 perpDexIndex;
        uint8 szDecimals;
        uint256 seed;
        uint256 activation;
    }

    function run() external {
        Config memory c = _config();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the broadcasting account, however run() was invoked

        address nvdax = c.nvdax != address(0) ? c.nvdax : address(new MockNVDAx(deployer));
        RiskParams risk = new RiskParams(deployer, DeployHelpers.defaultRisk());
        // the vault's pool key names the hook, and the hook trusts only that vault: hook first, vault, then bind
        AfterbellHook hook = _deployHook(IPoolManager(c.poolManager), deployer);
        PoolKey memory key = DeployHelpers.poolKey(c.usdc, nvdax, address(hook));

        AfterbellVault vault = new AfterbellVault(
            deployer,
            AfterbellVault.Wiring({
                usdc: IERC20(c.usdc),
                nvdax: IERC20(nvdax),
                morpho: IMorpho(c.morpho),
                poolManager: IPoolManager(c.poolManager),
                poolKey: key,
                risk: risk,
                coreDepositWallet: c.depositWallet,
                perpAsset: c.perpAsset,
                perpDexIndex: c.perpDexIndex,
                szDecimals: c.szDecimals
            })
        );
        hook.setVault(vault);
        // market A dumps into its own hookless pool, so the hook's pool stays on the oracle
        NaiveLiquidator naive = new NaiveLiquidator(
            deployer,
            IMorpho(c.morpho),
            IPoolManager(c.poolManager),
            DeployHelpers.thinPoolKey(c.usdc, nvdax),
            IERC20(nvdax)
        );
        PoolSeeder seeder = new PoolSeeder(deployer, IPoolManager(c.poolManager));
        PoolSwapTest router = new PoolSwapTest(IPoolManager(c.poolManager)); // public swaps: buyers of vault stock

        // Seed shares stay with the deployer; with the 6-decimal offset this makes share inflation pointless.
        if (c.seed > 0) {
            IERC20(c.usdc).approve(address(vault), c.seed);
            vault.deposit(c.seed, deployer);
        }
        // New Core accounts must exist before they send actions, and funding one in the same block doesn't work.
        if (c.activation > 0) vault.activateCore(c.activation);
        vm.stopBroadcast();

        _write(c.network, vault, hook, naive, seeder, router);
    }

    /// @dev CREATE2 through the deterministic deployer at an address whose low bits are the hook's permissions.
    ///      VERIFY on a new chain: `cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C` must not be empty.
    function _deployHook(IPoolManager pm, address owner_) internal returns (AfterbellHook hook) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(AfterbellHook).creationCode, abi.encode(pm, owner_)));
        (address mined, bytes32 salt) = DeployHelpers.mineHookSalt(CREATE2_FACTORY, AFTERBELL_HOOK_FLAGS, initCodeHash);
        hook = new AfterbellHook{salt: salt}(pm, owner_);
        require(address(hook) == mined, "hook not at its mined address: is the CREATE2 deployer on this chain?");
    }

    function _config() internal view returns (Config memory c) {
        c.network = vm.envOr("NETWORK", string("testnet"));
        c.usdc = vm.envOr("USDC_ADDRESS", HLConstants.usdc());
        c.depositWallet = vm.envOr("CORE_DEPOSIT_WALLET", HLConstants.coreDepositWallet());
        c.morpho = vm.envAddress("MORPHO_ADDRESS");
        c.poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        c.nvdax = vm.envOr("NVDAX_ADDRESS", address(0));
        c.perpAsset = uint32(vm.envUint("PERP_ASSET"));
        c.perpDexIndex = uint32(vm.envUint("PERP_DEX_INDEX"));
        c.szDecimals = uint8(vm.envUint("SZ_DECIMALS"));
        c.seed = vm.envOr("SEED_DEPOSIT", uint256(10e6));
        c.activation = vm.envOr("CORE_ACTIVATION", block.chainid == 998 ? 0 : uint256(2e6));
        require(c.activation <= c.seed, "activation comes out of the seed deposit");
    }

    function _write(
        string memory network,
        AfterbellVault vault,
        AfterbellHook hook,
        NaiveLiquidator naive,
        PoolSeeder seeder,
        PoolSwapTest router
    ) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(vault.usdc()));
        vm.serializeAddress(o, "morpho", address(vault.morpho()));
        vm.serializeAddress(o, "poolManager", address(vault.poolManager()));
        vm.serializeAddress(o, "nvdax", address(vault.nvdax()));
        vm.serializeAddress(o, "riskParams", address(vault.risk()));
        vm.serializeAddress(o, "vault", address(vault));
        vm.serializeAddress(o, "hook", address(hook));
        vm.serializeAddress(o, "coreDepositWallet", vault.coreDepositWallet());
        vm.serializeAddress(o, "naiveLiquidator", address(naive));
        vm.serializeAddress(o, "poolSeeder", address(seeder));
        vm.serializeAddress(o, "swapRouter", address(router));
        vm.serializeString(o, "poolKey", _poolKeyJson(vault));
        vm.serializeString(o, "thinPoolKey", _thinPoolKeyJson(naive));
        string memory json = vm.serializeString(o, "hypercore", _hypercoreJson(vault));

        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), network);
        vm.writeJson(json, path);
        console.log("wrote", path);
        console.log("next: CreateMarkets.s.sol, then SeedPool.s.sol");
    }

    function _poolKeyJson(AfterbellVault vault) internal returns (string memory) {
        (Currency c0, Currency c1, uint24 fee, int24 tickSpacing, IHooks hooks) = vault.poolKey();
        string memory k = "poolKey";
        vm.serializeAddress(k, "currency0", Currency.unwrap(c0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(c1));
        vm.serializeUint(k, "fee", fee);
        vm.serializeInt(k, "tickSpacing", tickSpacing);
        return vm.serializeAddress(k, "hooks", address(hooks));
    }

    function _thinPoolKeyJson(NaiveLiquidator naive) internal returns (string memory) {
        (Currency c0, Currency c1, uint24 fee, int24 tickSpacing, IHooks hooks) = naive.poolKey();
        string memory k = "thinPoolKey";
        vm.serializeAddress(k, "currency0", Currency.unwrap(c0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(c1));
        vm.serializeUint(k, "fee", fee);
        vm.serializeInt(k, "tickSpacing", tickSpacing);
        return vm.serializeAddress(k, "hooks", address(hooks));
    }

    function _hypercoreJson(AfterbellVault vault) internal returns (string memory) {
        string memory h = "hypercore";
        vm.serializeUint(h, "perpAsset", vault.perpAsset());
        vm.serializeUint(h, "perpIndex", vault.perpIndex());
        vm.serializeUint(h, "perpDexIndex", vault.perpDexIndex());
        return vm.serializeUint(h, "szDecimals", vault.szDecimals());
    }
}
