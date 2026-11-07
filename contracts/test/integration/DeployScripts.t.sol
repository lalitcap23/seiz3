// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {CreateMarkets} from "../../script/CreateMarkets.s.sol";
import {SeedPool} from "../../script/SeedPool.s.sol";
import {TestnetExtras} from "../../script/TestnetExtras.s.sol";
import {NaiveLiquidator} from "../../src/mocks/NaiveLiquidator.sol";
import {Faucet} from "../../src/mocks/Faucet.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";
import {Seiz3Vault} from "../../src/Seiz3Vault.sol";
import {Seiz3Hook, SEIZ3_HOOK_FLAGS} from "../../src/Seiz3Hook.sol";
import {MockUSDC} from "../utils/Seiz3Base.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";

/// @notice Runs Deploy → CreateMarkets → SeedPool (thin, then deep) the way `forge script` does: in a plain
///         EVM with no HyperCore precompiles. Writes and then deletes deployments/test-local.json.
/// @dev The scripts come from their artifacts (`deployCode`), not `new`: embedding all four (each carrying the vault
///      and the hook) would make this contract too big to deploy under the 30M test gas limit.
contract DeployScriptsTest is Test {
    using StateLibrary for IPoolManager;

    string constant NETWORK = "test-local";

    MockUSDC usdc;
    address wallet;
    IPoolManager pm;

    /// @dev Local stand-ins for what the scripts expect to find on chain.
    function setUp() public {
        usdc = new MockUSDC();
        MockHyperCore core = new MockHyperCore(usdc, 10_002, 1, 3);
        wallet = address(core.install(vm));
        vm.etch(address(0x80F), ""); // precompiles stay missing: scripts must not need them
        vm.etch(address(0x801), "");

        IMorpho morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(address(this))));
        address irm = deployCode("IrmMock.sol:IrmMock");
        morpho.enableIrm(irm);
        morpho.enableLltv(0.77 ether);
        morpho.enableLltv(0.385 ether);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        usdc.mint(DEFAULT_SENDER, 1_000_000e6);

        vm.setEnv("NETWORK", NETWORK);
        vm.setEnv("USDC_ADDRESS", vm.toString(address(usdc)));
        vm.setEnv("CORE_DEPOSIT_WALLET", vm.toString(wallet));
        vm.setEnv("MORPHO_ADDRESS", vm.toString(address(morpho)));
        vm.setEnv("MORPHO_IRM_ADDRESS", vm.toString(irm));
        vm.setEnv("POOL_MANAGER_ADDRESS", vm.toString(address(pm)));
        vm.setEnv("NVDAX_ADDRESS", vm.toString(address(0)));
        vm.setEnv("PERP_ASSET", "110002");
        vm.setEnv("PERP_DEX_INDEX", "1");
        vm.setEnv("SZ_DECIMALS", "3");
    }

    function test_scripts_deployMarketsAndSeedThePool() public {
        vm.pauseGasMetering(); // the whole stack takes more than the 30M a test may use
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), NETWORK);

        Seiz3Vault vault = _deployStep(path);
        _marketsStep(path, vault);
        (uint128 thin, uint128 deep) = _seedStep(path, vault);
        _extrasStep(path, vault, thin, deep);

        vm.removeFile(path);
    }

    /// @dev 1. deploy + seed deposit + Core activation; the hook is mined, deployed and bound to the vault
    function _deployStep(string memory path) internal returns (Seiz3Vault vault) {
        Deploy(deployCode("Deploy.s.sol:Deploy")).run();
        string memory json = vm.readFile(path);
        vault = Seiz3Vault(vm.parseJsonAddress(json, ".vault"));
        assertEq(vault.owner(), DEFAULT_SENDER, "owned by the broadcaster");
        assertGt(vault.balanceOf(DEFAULT_SENDER), 0, "seed shares");
        assertEq(usdc.balanceOf(address(vault)), 8e6, "10 USDC seed, 2 sent to Core");
        assertEq(vault.inTransit(), 2e6, "activation deposit in flight");
        assertTrue(vault.coreFunded(), "from here on share math reads HyperCore");
        assertEq(vm.parseJsonUint(json, ".hypercore.perpIndex"), 10_002);
        assertEq(vm.parseJsonAddress(json, ".coreDepositWallet"), wallet);

        Seiz3Hook hook = Seiz3Hook(vm.parseJsonAddress(json, ".hook"));
        assertEq(address(hook.vault()), address(vault), "hook bound to the vault");
        assertEq(hook.owner(), DEFAULT_SENDER);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, SEIZ3_HOOK_FLAGS, "mined address carries the flags");
        assertEq(address(_key(vault).hooks), address(hook), "vault's pool key names the hook");
        assertEq(_key(vault).fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(vm.parseJsonAddress(json, ".poolKey.hooks"), address(hook));
        assertEq(vm.parseJsonAddress(json, ".thinPoolKey.hooks"), address(0), "market A's pool has no hook");
        assertGt(vm.parseJsonAddress(json, ".swapRouter").code.length, 0, "public swap router");
    }

    /// @dev 2. markets merged into the same file; C allow-listed on the vault
    function _marketsStep(string memory path, Seiz3Vault vault) internal {
        CreateMarkets(deployCode("CreateMarkets.s.sol:CreateMarkets")).run();
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".vault"), address(vault), "deploy output preserved");
        Id c = Id.wrap(vm.parseJsonBytes32(json, ".markets.C_seiz3.id"));
        Id a = Id.wrap(vm.parseJsonBytes32(json, ".markets.A_naive.id"));
        assertTrue(vault.marketAllowed(c));
        assertFalse(vault.marketAllowed(a));
        assertTrue(Id.unwrap(a) != Id.unwrap(c), "own oracle per market, so A and C stay distinct");
        assertEq(vm.parseJsonString(json, ".markets.B_conservative.lltv"), "385000000000000000");
    }

    /// @dev 3. weekend depth on market A's own hookless pool; the vault's hooked pool is initialised by the deep seed
    function _seedStep(string memory path, Seiz3Vault vault) internal returns (uint128 thin, uint128 deep) {
        PoolId vaultPool = PoolIdLibrary.toId(_key(vault));
        PoolId thinPool = PoolIdLibrary.toId(_thinKey(vm.readFile(path)));
        SeedPool(deployCode("SeedPool.s.sol:SeedPool")).run(); // THIN defaults to true
        (uint160 sqrtP,,,) = pm.getSlot0(thinPool);
        assertGt(sqrtP, 0, "thin pool initialised");
        thin = pm.getLiquidity(thinPool);
        assertGt(thin, 0, "thin pool seeded");
        (sqrtP,,,) = pm.getSlot0(vaultPool);
        assertEq(sqrtP, 0, "the vault's pool waits for Monday");

        vm.setEnv("THIN", "false");
        SeedPool(deployCode("SeedPool.s.sol:SeedPool")).run();
        (sqrtP,,,) = pm.getSlot0(vaultPool);
        assertGt(sqrtP, 0, "initialised through the hook");
        deep = pm.getLiquidity(vaultPool);
        assertGt(deep, thin * 10, "Monday makers are back (100x USDC, ~3x range)");
    }

    /// @dev 4. testnet extras: faucet, swap router, and a fresh market A liquidator on the same thin pool
    function _extrasStep(string memory path, Seiz3Vault vault, uint128 thin, uint128 deep) internal {
        string memory json = vm.readFile(path);
        address oldNaive = vm.parseJsonAddress(json, ".naiveLiquidator");
        address hook = vm.parseJsonAddress(json, ".hook");
        vm.setEnv("FAUCET_OPERATOR", vm.toString(address(0xBEEF)));
        TestnetExtras(deployCode("TestnetExtras.s.sol:TestnetExtras")).run();
        json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".vault"), address(vault), "earlier fields preserved");
        assertEq(vm.parseJsonAddress(json, ".hook"), hook, "hook preserved");
        assertTrue(Faucet(payable(vm.parseJsonAddress(json, ".faucet"))).operators(address(0xBEEF)));
        assertGt(vm.parseJsonAddress(json, ".swapRouter").code.length, 0);
        NaiveLiquidator naive = NaiveLiquidator(vm.parseJsonAddress(json, ".naiveLiquidator"));
        assertTrue(address(naive) != oldNaive, "replaced");
        (,, uint24 fee,, IHooks naiveHooks) = naive.poolKey();
        assertEq(fee, DeployHelpers.THIN_POOL_FEE);
        assertEq(address(naiveHooks), address(0), "market A's pool has no hook");

        vm.setEnv("THIN", "true");
        SeedPool(deployCode("SeedPool.s.sol:SeedPool")).run();
        assertGt(pm.getLiquidity(PoolIdLibrary.toId(_thinKey(json))), thin, "thin pool topped up");
        assertEq(pm.getLiquidity(PoolIdLibrary.toId(_key(vault))), deep, "the vault's pool untouched");
    }

    function _key(Seiz3Vault vault) internal view returns (PoolKey memory key) {
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = vault.poolKey();
    }

    function _thinKey(string memory json) internal pure returns (PoolKey memory) {
        return DeployHelpers.thinPoolKey(vm.parseJsonAddress(json, ".usdc"), vm.parseJsonAddress(json, ".nvdax"));
    }
}
