// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {AfterbellBase} from "../utils/AfterbellBase.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";
import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";

/// @notice Unwind loop against the real v4 PoolManager: stock and short shrink together, then settle.
contract UnwindTest is AfterbellBase {
    using PoolIdLibrary for *;
    using StateLibrary for *;

    function setUp() public override {
        super.setUp();
        _takeAndHedge(); // Idle, 40 NVDA inventory, short −40_000
    }

    /// @dev Monday: makers are back at the oracle price and the stock market is open.
    function _monday() internal {
        _alignPool(CRASH_PX);
        vm.prank(owner);
        risk.setMarketOpen(true);
    }

    function _poolPx() internal view returns (uint256 px) {
        (, px) = UnwindLib.poolPrice(pm, key, nvdax0);
    }

    // ─── guards ───────────────────────────────────────────────────────────

    function test_unwind_revertsWhilePoolIsOffOracle() public {
        vm.expectRevert(IAfterbellVault.OracleBand.selector); // weekend pool still at $217
        vault.unwindStep();
    }

    function test_unwind_revertsWithHedgePending() public {
        _monday();
        _openBorrower(lp2, COLLATERAL, 6800); // 75.6% LTV at the crash price
        _setPrice(CRASH_PX * 90 / 100);
        vm.prank(keeper);
        vault.liquidate(market, lp2, 10e18);
        vm.expectRevert(IAfterbellVault.HedgePending.selector);
        vault.unwindStep();
    }

    function test_unwind_respectsCooldown() public {
        _monday();
        vault.unwindStep();
        _nextBlock(5);
        vault.syncHedge();
        vm.expectRevert(IAfterbellVault.Cooldown.selector); // 10s while open
        vault.unwindStep();
        vm.warp(block.timestamp + 5);
        vault.unwindStep();

        _nextBlock(5);
        vault.syncHedge();
        vm.prank(owner);
        risk.setMarketOpen(false);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(IAfterbellVault.Cooldown.selector); // 300s while closed
        vault.unwindStep();
    }

    function test_unwind_revertsWhenTheShortDrifted() public {
        _monday();
        core.forcePosition(address(vault), -30_000, 30_000 * _raw(CRASH_PX));
        vm.expectRevert(IAfterbellVault.HedgeDrift.selector); // never sell stock the short doesn't cover
        vault.unwindStep();
    }

    function test_unwind_blockedByOwnerPauseButNotByLowMargin() public {
        _monday();
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(IAfterbellVault.VaultPaused.selector);
        vault.unwindStep();
        vm.prank(owner);
        vault.unpause();

        core.forceDexBalance(address(vault), 1000e6);
        vault.syncHedge();
        assertEq(vault.pauseFlags(), vault.PAUSE_MARGIN());
        vault.unwindStep(); // raising cash is how a margin-starved vault recovers
        assertLt(vault.inventory(), SEIZE);
    }

    function test_unwind_slippageGuard() public {
        _monday();
        RiskParams.Params memory p = _risk();
        p.maxSlippageBps = 10; // pool fee alone is 30 bps
        _setRisk(p);
        vm.expectRevert(IAfterbellVault.Slippage.selector);
        vault.unwindStep();
    }

    function test_unwind_revertsWithNoInventory() public {
        AfterbellBase.setUp(); // fresh vault, nothing taken
        vm.expectRevert(IAfterbellVault.NoInventory.selector);
        vault.unwindStep();
    }

    // ─── one step ─────────────────────────────────────────────────────────

    function test_unwind_sellsOneChunkAndQueuesReduceOnlyBuy() public {
        _monday();
        uint256 idleBefore = usdc.balanceOf(address(vault));
        uint256 pxBefore = _poolPx();

        vault.unwindStep();

        uint256 chunk = Units.fromCoreSize(_risk().maxUnhedged, SZ_DEC); // 2 NVDA
        assertEq(vault.inventory(), SEIZE - chunk);
        uint256 out = usdc.balanceOf(address(vault)) - idleBefore;
        assertApproxEqRel(out, Units.value(chunk, CRASH_PX) * 997 / 1000, 0.001e18, "oracle value less 0.3% fee");
        assertLt(Units.diffBps(_poolPx(), pxBefore), 50, "impact under the cap");

        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, 2000, "buy back the short the sold stock no longer needs");
        assertEq(tries, 1);

        _nextBlock(5);
        MockHyperCore.Order memory o = core.lastOrder();
        assertTrue(o.isBuy);
        assertTrue(o.reduceOnly);
        assertEq(o.sz, 2000 * 1e5);
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -38_000);
    }

    function test_unwind_priceLimitCapsImpact() public {
        _monday();
        RiskParams.Params memory p = _risk();
        p.maxUnhedged = 40_000; // whole inventory in one go
        p.maxImpactBps = 5;
        _setRisk(p);
        uint256 pxBefore = _poolPx();

        vault.unwindStep();

        uint256 sold = SEIZE - vault.inventory();
        assertGt(sold, 0);
        assertLt(sold, SEIZE, "stopped at the price limit");
        assertLe(Units.diffBps(_poolPx(), pxBefore), 5);
        (int64 delta,) = _pending();
        assertEq(delta, int64(Units.toCoreSize(SEIZE, SZ_DEC)) - int64(Units.toCoreSize(vault.inventory(), SZ_DEC)));
    }

    // ─── the whole loop ───────────────────────────────────────────────────

    function test_unwind_fullLoop_settlesAndPaysTheQueue() public {
        // LP asks for everything while most cash is tied up: queued, not paid
        uint256 shares = vault.balanceOf(lp);
        vm.prank(lp);
        vault.requestWithdraw(shares);
        assertEq(vault.queued(lp), shares);
        assertEq(vault.balanceOf(address(vault)), shares, "queued shares held by the vault");

        _monday();
        uint256 steps;
        while (vault.inventory() > 0) {
            vault.unwindStep();
            _nextBlock(10);
            vault.syncHedge();
            ++steps;
            int64 gap = vault.confirmedShort() + _coreUnits(vault.inventory());
            assertLe(gap < 0 ? -gap : gap, int64(_risk().maxUnhedged), "neutral throughout");
        }
        assertEq(steps, 20);
        assertEq(vault.confirmedShort(), 0, "short closed in step");
        assertEq(core.szi(address(vault)), 0);

        // settle: sweep the activation leftover off spot, then bring the whole perp account home
        vault.sweepSpotToDex();
        _nextBlock(1);
        uint256 onCore = core.accountValue(address(vault));
        vault.withdrawMargin(onCore);
        uint256 idleBefore = usdc.balanceOf(address(vault));
        _nextBlock(1);
        assertEq(usdc.balanceOf(address(vault)) - idleBefore, onCore, "arrived next block");

        vm.prank(lp);
        vault.claimQueued();
        uint256 paid = usdc.balanceOf(lp);
        assertGt(paid, LP_DEPOSIT, "bonus beats fees, slippage and the 1 USDC activation fee");
        assertEq(vault.queued(lp), 0);
        emit log_named_decimal_uint("LP P&L (USDC)", paid - LP_DEPOSIT, 6);
    }

    function test_withdrawMargin_onlyWhenFlat() public {
        vm.expectRevert(IAfterbellVault.NotFlat.selector);
        vault.withdrawMargin(1000e6);
    }

    function test_withdrawMargin_cannotExceedCore() public {
        AfterbellBase.setUp(); // flat vault with CORE_MARGIN on xyz
        vm.expectRevert(IAfterbellVault.ExceedsCore.selector);
        vault.withdrawMargin(CORE_MARGIN + 1);
        vault.withdrawMargin(CORE_MARGIN);
        _nextBlock(1);
        assertEq(core.dexBalance(address(vault), DEX), 0);
    }
}
