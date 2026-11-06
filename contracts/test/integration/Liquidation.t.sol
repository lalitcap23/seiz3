// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {AfterbellBase} from "../utils/AfterbellBase.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";
import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {DemoOracle} from "../../src/mocks/DemoOracle.sol";
import {HedgeLib} from "../../src/libs/HedgeLib.sol";
import {Units} from "../../src/libs/Units.sol";

/// @notice Liquidation flow (Tx 1) and hedge confirmation (Tx 2) against real Morpho Blue bytecode.
contract LiquidationTest is AfterbellBase {
    int64 internal constant SEIZE_UNITS = 40_000;

    // ─── Tx 1: liquidate ──────────────────────────────────────────────────

    function test_liquidate_repaysLendersBooksInventoryAndSendsShort() public {
        _setPrice(CRASH_PX);
        uint256 debtSharesBefore = _borrowShares(borrower);
        uint256 idleBefore = usdc.balanceOf(address(vault));

        vm.expectEmit(false, true, false, false, address(vault));
        emit IAfterbellVault.LiquidationTaken(bytes32(0), borrower, SEIZE, 0, -SEIZE_UNITS, 0);
        _liquidate(SEIZE);

        // lenders made whole in the same tx; the vault paid at Morpho's 7.4% bonus
        uint256 repaid = idleBefore - usdc.balanceOf(address(vault));
        assertLt(_borrowShares(borrower), debtSharesBefore, "debt repaid");
        assertApproxEqRel(repaid, Units.value(SEIZE, CRASH_PX) * 1e18 / 1.0741e18, 0.001e18, "repaid at LIF");
        assertEq(usdc.allowance(address(vault), address(morpho)), 0, "approval fully used");

        assertEq(vault.inventory(), SEIZE);
        assertEq(nvdax.balanceOf(address(vault)), SEIZE);
        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, -SEIZE_UNITS, "pending = -sz");
        assertEq(tries, 1);
        assertEq(uint8(vault.hedgeState()), uint8(IAfterbellVault.HedgeState.Pending));

        // nothing reaches HyperCore until the block ends
        assertEq(core.orderCount(), 0);
        assertEq(core.queuedActions(), 1);
        _nextBlock(5);

        MockHyperCore.Order memory o = core.lastOrder();
        assertEq(o.asset, PERP_ASSET, "orders use the asset id");
        assertFalse(o.isBuy);
        assertFalse(o.reduceOnly);
        assertEq(o.tif, 3, "IOC");
        assertEq(o.sz, uint64(SEIZE_UNITS) * 1e5, "wire size");
        assertEq(o.limitPx, 19_347 * 1e6, "floor = oracle - 1% = 193.4757, 5 sig figs rounded down: 193.47");
        assertEq(o.cloid, HedgeLib.makeCloid(vault.hedgeId(), 1));
        assertEq(o.filled, uint64(SEIZE_UNITS), "landed in full");
    }

    function test_liquidate_revertsWhenPaused() public {
        _setPrice(CRASH_PX);
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(IAfterbellVault.VaultPaused.selector);
        _liquidate(SEIZE);
    }

    function test_liquidate_revertsWithHedgeInFlight() public {
        _setPrice(CRASH_PX);
        _liquidate(10e18);
        vm.expectRevert(IAfterbellVault.HedgePending.selector);
        _liquidate(10e18);
    }

    function test_liquidate_revertsOnMarketNotAllowed() public {
        _setPrice(CRASH_PX);
        DemoOracle other = new DemoOracle(owner, CRASH_PX * 1e18);
        MarketParams memory mp = MarketParams(address(usdc), address(nvdax), address(other), irm, LLTV);
        vm.prank(keeper);
        vm.expectRevert(IAfterbellVault.MarketNotAllowed.selector);
        vault.liquidate(mp, borrower, SEIZE);
    }

    function test_liquidate_revertsBelowOneCoreUnit() public {
        _setPrice(CRASH_PX);
        vm.expectRevert(IAfterbellVault.ZeroSize.selector);
        _liquidate(0.0009e18);
    }

    function test_liquidate_revertsOverCap() public {
        _setPrice(CRASH_PX);
        RiskParams.Params memory p = _risk();
        p.maxLiquidation = 5000e6;
        _setRisk(p);
        vm.expectRevert(IAfterbellVault.OverCap.selector);
        _liquidate(SEIZE); // ~$7.8k
    }

    /// @dev The Chainlink CRE report lowers the cap to what HyperCore's book can absorb, and a stale one stops
    ///      liquidations; the vault itself is unchanged, it reads both through `risk.get()`.
    function test_liquidate_cappedByTheCreHedgeCapacity() public {
        _setPrice(CRASH_PX);
        vm.prank(creForwarder);
        risk.onReport("", abi.encode(false, uint256(5000e6), uint64(block.timestamp)));

        uint256 snap = vm.snapshotState();
        vm.expectRevert(IAfterbellVault.OverCap.selector);
        _liquidate(SEIZE); // ~$7.8k into a book that takes $5k

        vm.revertToState(snap);
        _liquidate(SEIZE / 2);
        assertEq(vault.inventory(), SEIZE / 2);

        vm.revertToState(snap);
        vm.warp(block.timestamp + risk.maxReportAge() + 1);
        vm.expectRevert(IAfterbellVault.OverCap.selector);
        _liquidate(SEIZE / 2);
    }

    function test_liquidate_revertsWhenLendingOracleDisagreesWithCore() public {
        _setPrice(CRASH_PX);
        core.setPx(_raw(CRASH_PX * 102 / 100)); // Core 2% above Morpho, band is 1.5%
        vm.expectRevert(IAfterbellVault.OracleBand.selector);
        _liquidate(SEIZE);
    }

    function test_liquidate_revertsOnLowMargin() public {
        _setPrice(CRASH_PX);
        core.forceDexBalance(address(vault), 2000e6); // short of ~$7.8k needs $3.1k at 3x + 20%
        vm.expectRevert(IAfterbellVault.LowMargin.selector);
        _liquidate(SEIZE);
    }

    function test_liquidate_revertsWithoutCoreAccount() public {
        vault = _newVault(); // fresh vault, never activated
        vm.prank(owner);
        vault.setMarketAllowed(market, true);
        _deposit(lp, LP_DEPOSIT);
        _setPrice(CRASH_PX);
        vm.expectRevert(IAfterbellVault.CoreAccountMissing.selector);
        _liquidate(SEIZE);
    }

    function test_liquidate_revertsBelowDiscountFloor() public {
        _setPrice(CRASH_PX);
        RiskParams.Params memory p = _risk();
        p.minDiscountBps = 800; // Morpho only gives ~6.9% at 77% LLTV
        _setRisk(p);
        vm.expectRevert(IAfterbellVault.DiscountTooLow.selector);
        _liquidate(SEIZE);
    }

    function test_liquidate_keepsTheMarginReserve() public {
        _setPrice(CRASH_PX);
        uint256 shares = vault.convertToShares(75_500e6); // $20k sits on Core; this leaves ~$4.5k idle
        vm.prank(lp);
        vault.requestWithdraw(shares);
        assertLt(usdc.balanceOf(address(vault)), 8000e6);
        vm.expectRevert(IAfterbellVault.ExceedsIdle.selector);
        _liquidate(SEIZE); // repays ~$7.3k
    }

    // ─── Tx 2: syncHedge ──────────────────────────────────────────────────

    function test_sync_revertsInTheSameBlock() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        vm.expectRevert(IAfterbellVault.SameBlock.selector);
        vault.syncHedge();
        assertFalse(vault.canSync());
    }

    function test_sync_revertsBeforeOrderDelay() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        _nextBlock(1);
        vm.expectRevert(IAfterbellVault.TooEarly.selector);
        vault.syncHedge();
    }

    function test_sync_confirmsFullFill() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        _nextBlock(5);
        assertTrue(vault.canSync());

        vm.expectEmit(address(vault));
        emit IAfterbellVault.HedgeConfirmed(-SEIZE_UNITS, -SEIZE_UNITS);
        vault.syncHedge();

        assertEq(vault.confirmedShort(), -SEIZE_UNITS);
        (int64 delta,) = _pending();
        assertEq(delta, 0);
        assertEq(uint8(vault.hedgeState()), uint8(IAfterbellVault.HedgeState.Idle));
        assertFalse(vault.paused());
        assertEq(core.orderCount(), 1, "no extra orders");
    }

    function test_sync_partialFill_resendsRemainder() public {
        _setPrice(CRASH_PX);
        core.setFillBps(5000); // thin weekend book
        _liquidate(SEIZE);
        _nextBlock(5);
        vault.syncHedge();

        assertEq(vault.confirmedShort(), -20_000);
        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, -20_000, "remainder re-sent");
        assertEq(tries, 2);
        assertEq(uint8(vault.hedgeState()), uint8(IAfterbellVault.HedgeState.Retrying));

        core.setFillBps(10_000);
        _nextBlock(5);
        assertEq(core.lastOrder().cloid, HedgeLib.makeCloid(vault.hedgeId(), 2));
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -SEIZE_UNITS);
        (delta,) = _pending();
        assertEq(delta, 0);
    }

    function test_sync_noFill_pausesAfterMaxTries_thenSelfRecovers() public {
        _setPrice(CRASH_PX);
        core.setDropNext(type(uint256).max); // every order silently dropped
        _liquidate(SEIZE);

        for (uint256 i; i < 2; ++i) {
            _nextBlock(5);
            vault.syncHedge();
            assertFalse(vault.paused(), "still retrying");
        }
        _nextBlock(5);
        vm.expectEmit(address(vault));
        emit IAfterbellVault.HedgeStuck(-SEIZE_UNITS);
        vault.syncHedge(); // third miss
        assertTrue(vault.paused());
        assertEq(vault.pauseFlags(), vault.PAUSE_HEDGE());
        assertEq(uint8(vault.hedgeState()), uint8(IAfterbellVault.HedgeState.Paused));

        // paused stops new risk but keeps syncing
        assertEq(vault.maxDeposit(lp2), 0);
        vm.expectRevert(IAfterbellVault.VaultPaused.selector);
        _liquidate(1e18);

        core.setDropNext(0); // book refills
        _nextBlock(5);
        vault.syncHedge(); // sees nothing yet, re-sends (tries 5)
        _nextBlock(5);
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -SEIZE_UNITS);
        assertFalse(vault.paused(), "left Paused on its own");
    }

    function test_sync_overShort_buysBackReduceOnly() public {
        _takeAndHedge();
        core.forcePosition(address(vault), -45_000, 45_000 * _raw(CRASH_PX)); // late double fill
        vault.syncHedge(); // idle sync is a drift check
        (int64 delta,) = _pending();
        assertEq(delta, 5000);
        _nextBlock(5);
        MockHyperCore.Order memory o = core.lastOrder();
        assertTrue(o.isBuy);
        assertTrue(o.reduceOnly);
        assertEq(o.limitPx, 19_739 * 1e6, "cap = oracle + 1% = 197.3843, rounded up: 197.39");
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -SEIZE_UNITS);
    }

    function test_sync_whileIdle_rehedgesAfterCoreDropsTheShort() public {
        _takeAndHedge();
        bytes32 firstCycle = vault.hedgeId();
        core.forcePosition(address(vault), 0, 0); // e.g. Core liquidated the short
        vault.syncHedge();
        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, -SEIZE_UNITS);
        assertEq(tries, 1);
        assertTrue(vault.hedgeId() != firstCycle, "new cycle, fresh cloids");
    }

    function test_sync_withinTolerance_isHedged() public {
        _setPrice(CRASH_PX);
        core.setFillBps(9960); // 39_840 filled, gap 160 ≤ maxUnhedged 2_000
        _liquidate(SEIZE);
        _nextBlock(5);
        vault.syncHedge();
        (int64 delta,) = _pending();
        assertEq(delta, 0);
        assertEq(vault.confirmedShort(), -39_840);
    }

    // ─── margin ───────────────────────────────────────────────────────────

    function test_margin_rallyPausesThenTopUpRecovers() public {
        _takeAndHedge();
        // NVDA rallies 40%: short loses ~$3.1k, margin needed grows; leave the account thin first
        core.forceDexBalance(address(vault), 4000e6);
        _setPrice(CRASH_PX * 140 / 100);
        vault.syncHedge();
        assertEq(vault.pauseFlags(), vault.PAUSE_MARGIN());
        uint256 shortfall = vault.marginShortfall();
        assertGt(shortfall, 0);

        // keepers can't park more than 110% of the target on Core
        uint256 allIdle = usdc.balanceOf(address(vault));
        vm.prank(keeper);
        vm.expectRevert(IAfterbellVault.OverTarget.selector);
        vault.topUpMargin(allIdle);

        uint256 topUp = shortfall * 110 / 100;
        vm.prank(keeper);
        vault.topUpMargin(topUp);
        assertEq(vault.inTransit(), topUp, "counted while in flight");
        _nextBlock(1);
        assertEq(vault.inTransit(), 0, "visible on Core from the next block");
        vault.syncHedge();
        assertFalse(vault.paused());
    }

    function test_margin_viaSpotRoute() public {
        vm.prank(owner);
        vault.setMarginDepositDex(type(uint32).max);
        uint256 before = core.dexBalance(address(vault), DEX);
        vm.prank(owner);
        vault.topUpMargin(1000e6);
        _nextBlock(1);
        assertEq(core.dexBalance(address(vault), DEX), before + 1000e6, "deposit then sendAsset spot -> xyz");
        assertEq(core.spotWei(address(vault)), 4e8, "only the activation leftover stays on spot");
    }

    function test_sweepSpotToDex_movesActivationLeftover() public {
        assertEq(core.spotWei(address(vault)), 4e8); // 5 USDC - 1 USDC fee
        vault.sweepSpotToDex();
        _nextBlock(1);
        assertEq(core.spotWei(address(vault)), 0);
        assertEq(core.dexBalance(address(vault), DEX), CORE_MARGIN + 4e6);
        vm.expectRevert(IAfterbellVault.ZeroAmount.selector);
        vault.sweepSpotToDex();
    }

    // ─── LP accounting through the cycle ──────────────────────────────────

    function test_totalAssets_takesTheBonusAtLiquidation() public {
        _setPrice(CRASH_PX);
        uint256 before = vault.totalAssets();
        _liquidate(SEIZE);
        // stock worth ~$7.8k bought for ~$7.3k, marked at the Core oracle straight away
        uint256 bonus = Units.value(SEIZE, CRASH_PX) - Units.value(SEIZE, CRASH_PX) * 1e18 / 1.0741e18;
        assertApproxEqRel(vault.totalAssets() - before, bonus, 0.01e18);
    }

    function testFuzz_totalAssets_isDirectionNeutralOnceHedged(uint256 movePct) public {
        movePct = bound(movePct, 70, 130);
        _takeAndHedge();
        uint256 before = vault.totalAssets();
        core.setPx(_raw(CRASH_PX * movePct / 100));
        uint256 afterMove = vault.totalAssets();
        uint256 diff = afterMove > before ? afterMove - before : before - afterMove;
        assertLe(diff, 2e6, "stock and short net out (rounding only)");
    }
}
