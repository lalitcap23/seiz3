// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";

/// @notice Initialises the NVDAx/USDC v4 pool and adds liquidity via v4-periphery PositionManager.
/// THIN=true seeds weekend conditions; THIN=false adds the "Monday" deep liquidity.
/// VERIFY (spike 6): PoolManager + PositionManager addresses on HyperEVM.
contract SeedPool is Script {
    function run() external {
        bool thin = vm.envOr("THIN", true);
        thin;
        vm.startBroadcast();
        // TODO: poolManager.initialize(key, sqrtPriceX96) then PositionManager.modifyLiquidities(...)
        vm.stopBroadcast();
    }
}
