// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {CreateMarkets} from "../../script/CreateMarkets.s.sol";
import {SeedPool} from "../../script/SeedPool.s.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";
import {AfterbellVault} from "../../src/AfterbellVault.sol";
import {MockUSDC} from "../utils/AfterbellBase.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";

/// @notice Runs Deploy → CreateMarkets → SeedPool (thin, then deep) the way `forge script` does: in a plain
///         EVM with no HyperCore precompiles. Writes and then deletes deployments/test-local.json.
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
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), NETWORK);

        // 1. deploy + seed deposit + Core activation
        new Deploy().run();
        string memory json = vm.readFile(path);
        AfterbellVault vault = AfterbellVault(vm.parseJsonAddress(json, ".vault"));
        assertEq(vault.owner(), DEFAULT_SENDER, "owned by the broadcaster");
        assertGt(vault.balanceOf(DEFAULT_SENDER), 0, "seed shares");
        assertEq(usdc.balanceOf(address(vault)), 8e6, "10 USDC seed, 2 sent to Core");
        assertEq(vault.inTransit(), 2e6, "activation deposit in flight");
        assertTrue(vault.coreFunded(), "from here on share math reads HyperCore");
        assertEq(vm.parseJsonUint(json, ".hypercore.perpIndex"), 10_002);
        assertEq(vm.parseJsonAddress(json, ".coreDepositWallet"), wallet);

        // 2. markets merged into the same file; C allow-listed on the vault
        new CreateMarkets().run();
        json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".vault"), address(vault), "deploy output preserved");
        Id c = Id.wrap(vm.parseJsonBytes32(json, ".markets.C_afterbell.id"));
        Id a = Id.wrap(vm.parseJsonBytes32(json, ".markets.A_naive.id"));
        assertTrue(vault.marketAllowed(c));
        assertFalse(vault.marketAllowed(a));
        assertTrue(Id.unwrap(a) != Id.unwrap(c), "own oracle per market, so A and C stay distinct");
        assertEq(vm.parseJsonString(json, ".markets.B_conservative.lltv"), "385000000000000000");

        // 3. thin weekend pool, then deep Monday liquidity on top
        new SeedPool().run();
        (uint160 sqrtP,,,) = pm.getSlot0(PoolIdLibrary.toId(_key(json)));
        assertGt(sqrtP, 0, "initialised");
        uint128 thin = pm.getLiquidity(PoolIdLibrary.toId(_key(json)));
        vm.setEnv("THIN", "false");
        new SeedPool().run();
        assertGt(
            pm.getLiquidity(PoolIdLibrary.toId(_key(json))), thin * 10, "Monday makers are back (100x USDC, ~3x range)"
        );

        vm.removeFile(path);
    }

    function _key(string memory json) internal pure returns (PoolKey memory) {
        return DeployHelpers.poolKey(vm.parseJsonAddress(json, ".usdc"), vm.parseJsonAddress(json, ".nvdax"));
    }
}
