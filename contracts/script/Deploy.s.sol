// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

import {AfterbellVault} from "../src/AfterbellVault.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {NaiveLiquidator} from "../src/mocks/NaiveLiquidator.sol";
import {PoolSeeder} from "../src/mocks/PoolSeeder.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Deploys MockNVDAx, RiskParams, the vault, NaiveLiquidator and PoolSeeder; seeds the vault
///         (inflation guard) and starts HyperCore account activation; writes deployments/<NETWORK>.json.
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
        PoolKey memory key = DeployHelpers.poolKey(c.usdc, nvdax);

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
        NaiveLiquidator naive =
            new NaiveLiquidator(deployer, IMorpho(c.morpho), IPoolManager(c.poolManager), key, IERC20(nvdax));
        PoolSeeder seeder = new PoolSeeder(deployer, IPoolManager(c.poolManager));

        // Seed shares stay with the deployer; with the 6-decimal offset this makes share inflation pointless.
        if (c.seed > 0) {
            IERC20(c.usdc).approve(address(vault), c.seed);
            vault.deposit(c.seed, deployer);
        }
        // New Core accounts must exist before they send actions, and funding one in the same block doesn't work.
        if (c.activation > 0) vault.activateCore(c.activation);
        vm.stopBroadcast();

        _write(c.network, vault, naive, seeder);
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

    function _write(string memory network, AfterbellVault vault, NaiveLiquidator naive, PoolSeeder seeder) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(vault.usdc()));
        vm.serializeAddress(o, "morpho", address(vault.morpho()));
        vm.serializeAddress(o, "poolManager", address(vault.poolManager()));
        vm.serializeAddress(o, "nvdax", address(vault.nvdax()));
        vm.serializeAddress(o, "riskParams", address(vault.risk()));
        vm.serializeAddress(o, "vault", address(vault));
        vm.serializeAddress(o, "coreDepositWallet", vault.coreDepositWallet());
        vm.serializeAddress(o, "naiveLiquidator", address(naive));
        vm.serializeAddress(o, "poolSeeder", address(seeder));
        vm.serializeString(o, "poolKey", _poolKeyJson(vault));
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

    function _hypercoreJson(AfterbellVault vault) internal returns (string memory) {
        string memory h = "hypercore";
        vm.serializeUint(h, "perpAsset", vault.perpAsset());
        vm.serializeUint(h, "perpIndex", vault.perpIndex());
        vm.serializeUint(h, "perpDexIndex", vault.perpDexIndex());
        return vm.serializeUint(h, "szDecimals", vault.szDecimals());
    }
}
