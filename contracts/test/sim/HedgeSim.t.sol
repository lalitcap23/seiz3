// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {CoreSimulatorLib} from "@hyper-evm-lib/test/simulation/CoreSimulatorLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";
import {SimBase} from "../utils/SimBase.sol";

/// @notice Ring 2: the vault's HyperCore account in hyper-evm-lib's simulator (forks HyperEVM mainnet).
///         Run: pnpm contracts:test:sim
contract HedgeSimTest is SimBase {
    function test_sim_activationAndMarginViaSpot() public {
        _activateAndFund();
        assertEq(hyperCore.readPerpBalance(address(vault), DEX), 20_000e6, "xyz margin funded");
        assertApproxEqAbs(vault.coreUsdc(), 20_004e6, 1e6, "margin + activation leftover on spot");
        assertApproxEqAbs(vault.totalAssets(), 100_000e6 - 1e6, 1e6, "only the activation fee is gone");
    }

    function test_sim_liquidate_queuesOrder_syncSeesPosition() public {
        _activateAndFund();
        _crashAndLiquidate();
        assertEq(PrecompileLib.position(address(vault), PERP_INDEX).szi, 0, "not visible in the same block");

        _syncLater();
        int64 expected = -int64(Units.toCoreSize(SEIZE, szDec));
        assertEq(vault.confirmedShort(), expected);
        assertEq(PrecompileLib.position(address(vault), PERP_INDEX).szi, expected);
        (int64 delta,,,) = vault.pendingHedge();
        assertEq(delta, 0);
    }

    function test_sim_noFill_pausesAfterMaxTries_thenRecovers() public {
        _activateAndFund();
        CoreSimulatorLib.setMarkPx(PERP_INDEX, corePx * 95 / 100); // book below our sell floor
        _crashAndLiquidate();
        for (uint256 i; i < 3; ++i) {
            _syncLater();
        }
        assertTrue(vault.paused());
        assertEq(vault.confirmedShort(), 0);

        CoreSimulatorLib.setMarkPx(PERP_INDEX, corePx); // book refills
        _syncLater();
        _syncLater();
        assertEq(vault.confirmedShort(), -int64(Units.toCoreSize(SEIZE, szDec)));
        assertFalse(vault.paused());
    }

    function test_sim_unwindStep_reducesTheShortInStep() public {
        _activateAndFund();
        _crashAndLiquidate();
        _syncLater();
        vm.prank(owner);
        risk.setMarketOpen(true);

        vault.unwindStep();
        _syncLater();
        int64 expected = -int64(Units.toCoreSize(SEIZE, szDec)) + int64(DeployHelpers.defaultRisk().maxUnhedged);
        assertEq(vault.confirmedShort(), expected);
        assertEq(int64(Units.toCoreSize(vault.inventory(), szDec)), -expected, "stock and short shrank together");
    }

    /// @dev A buyer fills from the vault through the hook; the reduce-only buy it queues lands on the simulated
    ///      HyperCore like an unwind's.
    function test_sim_hookFill_buyBackLandsOnCore() public {
        _hookFillAndSync();
    }
}
