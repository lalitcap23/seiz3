// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseSimulatorTest} from "@hyper-evm-lib/test/BaseSimulatorTest.sol";

/// @notice Ring 2: hyper-evm-lib CoreSimulator. Requires network (forks HyperEVM mainnet in setUp).
/// Run: pnpm contracts:test:sim
contract HedgeSimTest is BaseSimulatorTest {
    function setUp() public override {
        super.setUp();
        // TODO: deploy vault, hyperCore.forceAccountActivation(vault), fund perp margin
    }

    function test_liquidate_queuesOrder_syncSeesPosition() public {
        vm.skip(true); // TODO: liquidate → CoreSimulatorLib.nextBlock() → syncHedge → assert confirmedShort
    }

    function test_partialFill_retries() public {
        vm.skip(true);
    }

    function test_noFill_pausesAfterMaxTries() public {
        vm.skip(true);
    }
}
