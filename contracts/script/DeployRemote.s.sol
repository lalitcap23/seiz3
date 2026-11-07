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

import {SEIZ3_HOOK_FLAGS} from "../src/remote/Seiz3HookRemote.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {HedgeLib} from "../src/libs/HedgeLib.sol";
import {MockNVDAx} from "../src/mocks/MockNVDAx.sol";
import {NaiveLiquidator} from "../src/mocks/NaiveLiquidator.sol";
import {PoolSeeder} from "../src/mocks/PoolSeeder.sol";
import {HyperCoreGateway} from "../src/remote/HyperCoreGateway.sol";
import {Seiz3VaultRemote} from "../src/remote/Seiz3VaultRemote.sol";
import {Seiz3HookRemote} from "../src/remote/Seiz3HookRemote.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Deploys the Base Sepolia system: MockNVDAx, RiskParams, HyperCoreGateway, Seiz3HookRemote
///         (at a mined CREATE2 address), Seiz3VaultRemote, NaiveLiquidator, PoolSeeder and the public swap router,
///         against the official Morpho Blue and Uniswap v4 PoolManager; seeds the vault; writes
///         deployments/<NETWORK>.json, including `hyperCoreGateway`, `hedgeAccount` and `relayer`.
///         CreateMarkets.s.sol and SeedPool.s.sol then read it.
///
///   NETWORK=base-sepolia RELAYER_ADDRESS=0x… HEDGE_ACCOUNT=0x… forge script script/DeployRemote.s.sol \
///     --rpc-url base_sepolia --broadcast --slow
contract DeployRemote is Script {
    /// @dev Chainlink CRE forwarders on Base Sepolia (docs.chain.link/cre, forwarder directory): the simulation one,
    ///      which `cre workflow simulate --broadcast` writes through, unless CRE_PRODUCTION=true.
    address constant BASE_SEPOLIA_SIM_FORWARDER = 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5;
    address constant BASE_SEPOLIA_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    struct Config {
        string network;
        address usdc;
        address morpho;
        address poolManager;
        address nvdax; // 0 → deploy MockNVDAx
        address swapRouter; // 0 → deploy a PoolSwapTest
        uint32 perpAsset;
        uint32 perpDexIndex;
        uint8 szDecimals;
        uint256 seed;
        address creForwarder;
        address relayer;
        address hedgeAccount;
        uint32 maxStateAge;
    }

    struct Deployed {
        RiskParams risk;
        HyperCoreGateway gateway;
        Seiz3HookRemote hook;
        Seiz3VaultRemote vault;
        NaiveLiquidator naive;
        PoolSeeder seeder;
        address router;
    }

    function run() external {
        Config memory c = _config();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Deployed memory d;

        address nvdax = c.nvdax != address(0) ? c.nvdax : address(new MockNVDAx(deployer));
        address forwarder = c.creForwarder != address(0) ? c.creForwarder : _forwarder(deployer);
        address relayer = c.relayer != address(0) ? c.relayer : deployer;
        d.risk = new RiskParams(deployer, forwarder, DeployHelpers.defaultRisk());
        d.gateway =
            new HyperCoreGateway(deployer, forwarder, relayer, HedgeLib.perpIndexOf(c.perpAsset), c.perpDexIndex);
        if (c.maxStateAge != 0) d.gateway.setMaxStateAge(c.maxStateAge);
        // the vault's pool key names the hook, and the hook trusts only that vault: hook first, vault, then bind
        d.hook = _deployHook(IPoolManager(c.poolManager), deployer);
        PoolKey memory key = DeployHelpers.poolKey(c.usdc, nvdax, address(d.hook));

        d.vault = new Seiz3VaultRemote(
            deployer,
            Seiz3VaultRemote.Wiring({
                usdc: IERC20(c.usdc),
                nvdax: IERC20(nvdax),
                morpho: IMorpho(c.morpho),
                poolManager: IPoolManager(c.poolManager),
                poolKey: key,
                risk: d.risk,
                gateway: d.gateway,
                perpAsset: c.perpAsset,
                perpDexIndex: c.perpDexIndex,
                szDecimals: c.szDecimals
            })
        );
        d.gateway.setAccount(address(d.vault));
        d.gateway.setHedgeAccount(c.hedgeAccount != address(0) ? c.hedgeAccount : relayer);
        d.hook.setVault(d.vault);
        // market A dumps into its own hookless pool, so the hook's pool stays on the oracle
        d.naive = new NaiveLiquidator(
            deployer,
            IMorpho(c.morpho),
            IPoolManager(c.poolManager),
            DeployHelpers.thinPoolKey(c.usdc, nvdax),
            IERC20(nvdax)
        );
        d.seeder = new PoolSeeder(deployer, IPoolManager(c.poolManager));
        d.router = c.swapRouter != address(0) ? c.swapRouter : address(new PoolSwapTest(IPoolManager(c.poolManager)));

        // Seed shares stay with the deployer; with the 6-decimal offset this makes share inflation pointless.
        if (c.seed > 0) {
            IERC20(c.usdc).approve(address(d.vault), c.seed);
            d.vault.deposit(c.seed, deployer);
        }
        vm.stopBroadcast();

        _write(c.network, d);
    }

    /// @dev CREATE2 through the deterministic deployer at an address whose low bits are the hook's permissions.
    function _deployHook(IPoolManager pm, address owner_) internal returns (Seiz3HookRemote hook) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(Seiz3HookRemote).creationCode, abi.encode(pm, owner_)));
        (address mined, bytes32 salt) = DeployHelpers.mineHookSalt(CREATE2_FACTORY, SEIZ3_HOOK_FLAGS, initCodeHash);
        hook = new Seiz3HookRemote{salt: salt}(pm, owner_);
        require(address(hook) == mined, "hook not at its mined address: is the CREATE2 deployer on this chain?");
    }

    function _forwarder(address fallback_) internal view returns (address) {
        if (block.chainid == 84_532) {
            return vm.envOr("CRE_PRODUCTION", false) ? BASE_SEPOLIA_FORWARDER : BASE_SEPOLIA_SIM_FORWARDER;
        }
        return fallback_; // anvil: the deployer can post reports itself
    }

    function _config() internal view returns (Config memory c) {
        c.network = vm.envOr("NETWORK", string("base-sepolia"));
        c.usdc = vm.envAddress("USDC_ADDRESS");
        c.morpho = vm.envAddress("MORPHO_ADDRESS");
        c.poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        c.nvdax = vm.envOr("NVDAX_ADDRESS", address(0));
        c.swapRouter = vm.envOr("SWAP_ROUTER", address(0));
        c.perpAsset = uint32(vm.envUint("PERP_ASSET"));
        c.perpDexIndex = uint32(vm.envUint("PERP_DEX_INDEX"));
        c.szDecimals = uint8(vm.envUint("SZ_DECIMALS"));
        c.seed = vm.envOr("SEED_DEPOSIT", uint256(10e6));
        c.creForwarder = vm.envOr("CRE_FORWARDER", address(0));
        c.relayer = vm.envOr("RELAYER_ADDRESS", address(0));
        c.hedgeAccount = vm.envOr("HEDGE_ACCOUNT", address(0));
        c.maxStateAge = uint32(vm.envOr("MAX_STATE_AGE", uint256(0)));
    }

    function _write(string memory network, Deployed memory d) internal {
        Seiz3VaultRemote vault = d.vault;
        string memory o = "deployment";
        vm.serializeString(o, "architecture", "remote");
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number); // where log scans (keeper borrowers, API feed) begin
        vm.serializeAddress(o, "usdc", address(vault.usdc()));
        vm.serializeAddress(o, "morpho", address(vault.morpho()));
        vm.serializeAddress(o, "poolManager", address(vault.poolManager()));
        vm.serializeAddress(o, "nvdax", address(vault.nvdax()));
        vm.serializeAddress(o, "riskParams", address(d.risk));
        vm.serializeAddress(o, "creForwarder", d.risk.getForwarderAddress());
        vm.serializeAddress(o, "vault", address(vault));
        vm.serializeAddress(o, "hook", address(d.hook));
        vm.serializeAddress(o, "hyperCoreGateway", address(d.gateway));
        vm.serializeAddress(o, "hedgeAccount", d.gateway.hedgeAccount());
        vm.serializeAddress(o, "relayer", d.gateway.relayer());
        vm.serializeAddress(o, "coreDepositWallet", vault.coreDepositWallet());
        vm.serializeAddress(o, "naiveLiquidator", address(d.naive));
        vm.serializeAddress(o, "poolSeeder", address(d.seeder));
        vm.serializeAddress(o, "swapRouter", d.router);
        vm.serializeString(o, "poolKey", _keyJson("poolKey", vault.poolKey));
        vm.serializeString(o, "thinPoolKey", _keyJson("thinPoolKey", d.naive.poolKey));
        string memory json = vm.serializeString(o, "hypercore", _hypercoreJson(vault));

        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), network);
        vm.writeJson(json, path);
        console.log("wrote", path);
        console.log("vault", address(vault));
        console.log("gateway", address(d.gateway));
        console.log("next: CreateMarkets.s.sol (MORPHO_IRM_ADDRESS=0x0), SeedPool.s.sol, RemoteActors.s.sol");
    }

    function _keyJson(
        string memory k,
        function() external view returns (Currency, Currency, uint24, int24, IHooks) poolKeyOf
    ) internal returns (string memory) {
        (Currency c0, Currency c1, uint24 fee, int24 tickSpacing, IHooks hooks) = poolKeyOf();
        vm.serializeAddress(k, "currency0", Currency.unwrap(c0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(c1));
        vm.serializeUint(k, "fee", fee);
        vm.serializeInt(k, "tickSpacing", tickSpacing);
        return vm.serializeAddress(k, "hooks", address(hooks));
    }

    function _hypercoreJson(Seiz3VaultRemote vault) internal returns (string memory) {
        string memory h = "hypercore";
        vm.serializeUint(h, "perpAsset", vault.perpAsset());
        vm.serializeUint(h, "perpIndex", vault.perpIndex());
        vm.serializeUint(h, "perpDexIndex", vault.perpDexIndex());
        return vm.serializeUint(h, "szDecimals", vault.szDecimals());
    }
}
