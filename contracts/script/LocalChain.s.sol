// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";

import {MockUSDC} from "../test/utils/AfterbellBase.sol";
import {MockHyperCore} from "../test/utils/MockHyperCore.sol";
import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice What a local anvil lacks and HyperEVM already has: USDC, Morpho Blue (+ IRM, LLTVs), the Uniswap v4
///         PoolManager, and HyperCore. Real Morpho and PoolManager bytecode (the test artifacts); MockHyperCore for
///         HyperCore, whose stubs scripts/local-stack.sh then copies over the precompiles and CoreWriter.
///         Writes deployments/local-chain.json, which feeds the real Deploy / CreateMarkets / SeedPool scripts.
///
///   forge script script/LocalChain.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil 0> --broadcast
contract LocalChain is Script {
    uint32 constant PERP_INDEX = 10_002; // xyz:NVDA: dex 1, index 2
    uint32 constant DEX = 1;
    uint8 constant SZ_DECIMALS = 3;
    uint64 constant START_PX = 217_000; // raw perp px ($217.000 at szDecimals 3)

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        MockUSDC usdc = new MockUSDC();
        usdc.mint(deployer, 10_000_000e6);

        IMorpho morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(deployer)));
        address irm = deployCode("IrmMock.sol:IrmMock");
        morpho.enableIrm(irm);
        morpho.enableLltv(0.77 ether);
        morpho.enableLltv(0.385 ether);

        address poolManager = deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));

        MockHyperCore core = new MockHyperCore(IERC20(address(usdc)), PERP_INDEX, DEX, SZ_DECIMALS);
        (address precompileStub, address coreWriterStub) = core.deployStubs();
        core.setPx(START_PX);
        vm.stopBroadcast();

        string memory o = "localChain";
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "morpho", address(morpho));
        vm.serializeAddress(o, "irm", irm);
        vm.serializeAddress(o, "poolManager", poolManager);
        vm.serializeAddress(o, "core", address(core));
        vm.serializeAddress(o, "coreDepositWallet", address(core.depositWallet()));
        vm.serializeAddress(o, "precompileStub", precompileStub);
        string memory json = vm.serializeAddress(o, "coreWriterStub", coreWriterStub);

        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), "local-chain");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
