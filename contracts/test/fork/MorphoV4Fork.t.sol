// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Ring 3: real Morpho Blue + Uniswap v4 bytecode on a HyperEVM fork.
/// Run: pnpm contracts:test:fork   (needs HYPEREVM_RPC_URL)
contract MorphoV4ForkTest is Test {
    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("hyperevm"));
    }

    function test_morphoLiquidate_withCallback() public {
        vm.skip(true); // TODO: spike 5
    }

    function test_v4Swap_throughUnlock() public {
        vm.skip(true); // TODO: spike 6
    }
}
