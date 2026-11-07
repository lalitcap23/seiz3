// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";

import {MockUSDC} from "../test/utils/Seiz3Base.sol";
import {MockHyperCore} from "../test/utils/MockHyperCore.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice Step 0 of the Base Sepolia architecture (scripts/base-stack.sh): what the vault needs that isn't ours.
///   - Morpho Blue and the Uniswap v4 PoolManager: the official deployments wherever they exist (Base Sepolia, or a
///     fork of it). Only a plain local anvil gets their bytecode, set up the way Base Sepolia's Morpho is (no IRM,
///     77% and 38.5% LLTVs).
///   - USDC: a mintable 6-decimal test token (USDC_ADDRESS reuses one). Circle's faucet can't fund a demo round, and
///     nothing bridges it to HyperCore anyway: the hedge account's margin lives on HyperCore.
///   - HyperCore, local only (MOCK_CORE, default on anvil): MockHyperCore at an ordinary address, which the relayer's
///     `mock` backend trades and reads. Nothing is etched over precompiles: this chain has none.
/// Writes deployments/<NETWORK>-infra.json, which feeds DeployRemote / CreateMarkets / SeedPool.
///
///   NETWORK=base-sepolia forge script script/RemoteInfra.s.sol --rpc-url base_sepolia --broadcast
contract RemoteInfra is Script {
    address constant BASE_SEPOLIA_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BASE_SEPOLIA_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    /// @dev Uniswap's own test router on Base Sepolia (developers.uniswap.org, v4 deployments).
    address constant BASE_SEPOLIA_POOL_SWAP_TEST = 0x8B5bcC363ddE2614281aD875bad385E0A785D3B9;

    function run() external {
        string memory network = vm.envOr("NETWORK", string("base-sepolia"));
        bool mockCore = vm.envOr("MOCK_CORE", block.chainid == 31337);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        address usdc = vm.envOr("USDC_ADDRESS", address(0));
        if (usdc == address(0)) usdc = address(new MockUSDC());
        uint256 mint = vm.envOr("USDC_MINT", uint256(10_000_000e6));
        if (mint > 0) MockUSDC(usdc).mint(deployer, mint);

        bool official = BASE_SEPOLIA_MORPHO.code.length > 0 && BASE_SEPOLIA_POOL_MANAGER.code.length > 0;
        address morpho = vm.envOr("MORPHO_ADDRESS", official ? BASE_SEPOLIA_MORPHO : address(0));
        if (morpho == address(0)) {
            morpho = deployCode("Morpho.sol:Morpho", abi.encode(deployer));
            IMorpho(morpho).enableIrm(address(0));
            IMorpho(morpho).enableLltv(0.77 ether);
            IMorpho(morpho).enableLltv(0.385 ether);
        }
        address poolManager = vm.envOr("POOL_MANAGER_ADDRESS", official ? BASE_SEPOLIA_POOL_MANAGER : address(0));
        if (poolManager == address(0)) poolManager = deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
        address swapRouter = BASE_SEPOLIA_POOL_SWAP_TEST.code.length > 0 ? BASE_SEPOLIA_POOL_SWAP_TEST : address(0);

        address core;
        if (mockCore) core = _mockCore(usdc);
        vm.stopBroadcast();

        string memory o = "remoteInfra";
        vm.serializeBool(o, "official", official);
        vm.serializeAddress(o, "usdc", usdc);
        vm.serializeAddress(o, "morpho", morpho);
        vm.serializeAddress(o, "irm", address(0));
        vm.serializeAddress(o, "poolManager", poolManager);
        vm.serializeAddress(o, "swapRouter", swapRouter);
        string memory json = vm.serializeAddress(o, "core", core);
        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), string.concat(network, "-infra"));
        vm.writeJson(json, path);
        console.log("wrote", path);
        console.log(official ? "Morpho + PoolManager: official deployments" : "Morpho + PoolManager: local bytecode");
    }

    /// @dev HyperCore for the relayer's mock backend: testnet's xyz:NVDA ids, and the hedge account live with margin.
    function _mockCore(address usdc) internal returns (address) {
        uint32 perpIndex = uint32(vm.envOr("PERP_INDEX", uint256(650_002)));
        uint32 dex = uint32(vm.envOr("PERP_DEX_INDEX", uint256(65)));
        uint8 szDecimals = uint8(vm.envOr("SZ_DECIMALS", uint256(3)));
        MockHyperCore core = new MockHyperCore(IERC20(usdc), perpIndex, dex, szDecimals);
        core.setPx(uint64(vm.envOr("START_PRICE_USD6", uint256(217e6)) / 10 ** szDecimals));
        address hedge = vm.envOr("HEDGE_ACCOUNT", address(0));
        if (hedge != address(0)) {
            core.forceActivate(hedge);
            core.forceDexBalance(hedge, uint64(vm.envOr("CORE_MARGIN_USD6", uint256(120e6))));
        }
        return address(core);
    }
}
