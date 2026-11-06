// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";

import {DeployHelpers} from "./DeployHelpers.sol";

/// @notice What HyperEVM testnet lacks and mainnet has: Morpho Blue (+ IRM, LLTVs) and the Uniswap v4 PoolManager.
///         The same real bytecode LocalChain.s.sol puts on anvil (the test artifacts). USDC and HyperCore are real on
///         testnet, so no mocks. Writes deployments/testnet-infra.json; its addresses feed Deploy / CreateMarkets.
/// Mainnet needs none of this: Morpho 0x68e37dE8…, its IRM 0xD4a426F0… and PoolManager 0x12D4Fd9C… (.env.example).
/// Big blocks first (README): PoolManager alone is ~24 KB.
///
///   forge script script/TestnetInfra.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract TestnetInfra is Script {
    function run() external {
        require(block.chainid == 998, "testnet only: mainnet already has Morpho and v4");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        IMorpho morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(deployer)));
        address irm = deployCode("IrmMock.sol:IrmMock"); // x% utilization = x% APR; fine for a demo market
        morpho.enableIrm(irm);
        morpho.enableLltv(0.77 ether);
        morpho.enableLltv(0.385 ether);

        address poolManager = deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
        vm.stopBroadcast();

        string memory o = "testnetInfra";
        vm.serializeAddress(o, "morpho", address(morpho));
        vm.serializeAddress(o, "irm", irm);
        string memory json = vm.serializeAddress(o, "poolManager", poolManager);

        string memory path = DeployHelpers.deploymentPath(vm.projectRoot(), "testnet-infra");
        vm.writeJson(json, path);
        console.log("wrote", path);
        console.log("MORPHO_ADDRESS", address(morpho));
        console.log("MORPHO_IRM_ADDRESS", irm);
        console.log("POOL_MANAGER_ADDRESS", poolManager);
    }
}
