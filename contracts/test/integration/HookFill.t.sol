// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {Seiz3Base} from "../utils/Seiz3Base.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";
import {Seiz3Hook} from "../../src/Seiz3Hook.sol";
import {ISeiz3Vault} from "../../src/interfaces/ISeiz3Vault.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";

/// @notice Seiz3Hook against the real v4 PoolManager: buyers of NVDAx are filled from the vault's hedged
///         inventory at the Core oracle price plus the spread, each fill queues the matching reduce-only buy, and
///         curve swaps pay the fee for the market hours.
contract HookFillTest is Seiz3Base {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal buyer = makeAddr("buyer");

    uint256 internal constant CHUNK = 2e18; // maxUnhedged: 2000 Core units at szDecimals 3
    uint256 internal constant ASK = 197.3843e6; // CRASH_PX × 1.01, the after-hours spread

    function setUp() public override {
        super.setUp();
        _takeAndHedge(); // Idle, 40 NVDA, short −40_000; Core oracle at the crash, the pool still at $217
        _fundBuyer();
    }

    function _fundBuyer() internal {
        usdc.mint(buyer, 1_000_000e6);
        _mintNvdax(buyer, 100e18);
        vm.startPrank(buyer);
        usdc.approve(address(swapRouter), type(uint256).max);
        nvdax.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev USDC → NVDAx. Negative = exact USDC in, positive = exact NVDAx out.
    function _buy(int256 amountSpecified) internal {
        bool zeroForOne = !nvdax0; // pay USDC in
        vm.prank(buyer);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Exact NVDAx in → USDC out, through the curve.
    function _sell(uint256 nvdaxIn) internal returns (uint256 usdcOut) {
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: nvdax0,
                amountSpecified: -int256(nvdaxIn),
                sqrtPriceLimitX96: nvdax0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        usdcOut = usdc.balanceOf(buyer) - before;
    }

    function _sqrtPrice() internal view returns (uint160 sqrtP) {
        (sqrtP,,,) = pm.getSlot0(key.toId());
    }

    function _usdcFor(uint256 nvdaxOut) internal pure returns (uint256) {
        return Math.mulDiv(nvdaxOut, ASK, 1e18, Math.Rounding.Ceil);
    }

    // ─── quote ────────────────────────────────────────────────────────────

    function test_quote_askIsTheCoreOraclePlusTheSpread() public view {
        (uint256 capacity, uint256 ask, uint24 fee, bool open) = hook.quote();
        assertEq(ask, ASK);
        assertEq(capacity, CHUNK, "one fill is at most maxUnhedged");
        assertEq(fee, 10_000, "1% after the bell");
        assertFalse(open);
    }

    // ─── fills ────────────────────────────────────────────────────────────

    function test_buyExactOut_fillsFromTheVaultAtTheAsk() public {
        uint256 idle = usdc.balanceOf(address(vault));
        uint256 cash = usdc.balanceOf(buyer);
        uint256 stock = nvdax.balanceOf(buyer);
        uint160 sqrtBefore = _sqrtPrice();
        uint256 usdcIn = _usdcFor(1.5e18);

        vm.expectEmit(address(vault));
        emit ISeiz3Vault.Unwound(1.5e18, usdcIn); // inside the fill
        vm.expectEmit(address(hook));
        emit Seiz3Hook.InventoryFill(address(swapRouter), 1.5e18, usdcIn, ASK, false);
        _buy(int256(1.5e18));

        assertEq(nvdax.balanceOf(buyer) - stock, 1.5e18);
        assertEq(cash - usdc.balanceOf(buyer), usdcIn, "paid the ask, no LP fee");
        assertEq(usdc.balanceOf(address(vault)) - idle, usdcIn, "the vault got every cent");
        assertEq(vault.inventory(), SEIZE - 1.5e18);
        assertEq(_sqrtPrice(), sqrtBefore, "the curve never moved");

        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, 1500, "buy back the short the sold stock no longer needs");
        assertEq(tries, 1);

        _nextBlock(5);
        MockHyperCore.Order memory o = core.lastOrder();
        assertTrue(o.isBuy);
        assertTrue(o.reduceOnly);
        assertEq(o.sz, 1500 * 1e5);
        vault.syncHedge();
        assertEq(vault.confirmedShort(), -38_500);
        assertEq(uint8(vault.hedgeState()), uint8(ISeiz3Vault.HedgeState.Idle));
    }

    function test_buyExactIn_fillsOnTheCoreGridAndTheCurveTakesTheDust() public {
        uint256 idle = usdc.balanceOf(address(vault));
        uint256 cash = usdc.balanceOf(buyer);
        uint256 stock = nvdax.balanceOf(buyer);
        uint256 sold = Units.fromCoreSize(Units.toCoreSize(300e6 * 1e18 / ASK, SZ_DEC), SZ_DEC); // 1.519 NVDA

        _buy(-300e6);

        assertEq(SEIZE - vault.inventory(), sold);
        assertEq(usdc.balanceOf(address(vault)) - idle, _usdcFor(sold));
        assertEq(cash - usdc.balanceOf(buyer), 300e6, "exact in");
        assertGt(nvdax.balanceOf(buyer) - stock, sold, "the few cents left over bought a little on the curve");
        (int64 delta,) = _pending();
        assertEq(delta, int64(Units.toCoreSize(sold, SZ_DEC)));
    }

    function test_bigBuy_fillsTheCapAndTheCurveTakesTheRest() public {
        uint256 stock = nvdax.balanceOf(buyer);
        uint160 sqrtBefore = _sqrtPrice();

        _buy(int256(5e18));

        assertEq(vault.inventory(), SEIZE - CHUNK, "the hook sold maxUnhedged");
        assertEq(nvdax.balanceOf(buyer) - stock, 5e18, "the buyer still got all 5");
        assertTrue(_sqrtPrice() != sqrtBefore, "3 NVDA came from the curve");
    }

    function test_secondBuyBeforeTheSync_goesToTheCurve() public {
        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE - 1e18);
        (uint256 capacity,,,) = hook.quote();
        assertEq(capacity, 0, "one hedge in flight");

        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE - 1e18, "pass-through");

        _nextBlock(5);
        vault.syncHedge();
        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE - 2e18, "open again once the buy-back is confirmed");
    }

    function test_buyers_unwindTheWholePosition() public {
        for (uint256 i; i < SEIZE / CHUNK; ++i) {
            _buy(int256(CHUNK));
            _nextBlock(5);
            vault.syncHedge();
        }
        assertEq(vault.inventory(), 0);
        assertEq(vault.confirmedShort(), 0);
        (int64 delta,) = _pending();
        assertEq(delta, 0);

        vault.withdrawMargin(1000e6); // flat: the margin can come home
        _nextBlock(1);
    }

    function testFuzz_buy_wholeCoreUnitsAndNeverBelowTheAsk(uint256 usdcIn) public {
        usdcIn = bound(usdcIn, 1e6, 2000e6);
        uint256 inv = vault.inventory();
        uint256 idle = usdc.balanceOf(address(vault));
        uint256 assets = vault.totalAssets();

        _buy(-int256(usdcIn));

        uint256 sold = inv - vault.inventory();
        uint256 got = usdc.balanceOf(address(vault)) - idle;
        assertGt(sold, 0);
        assertLe(sold, CHUNK);
        assertEq(sold % 1e15, 0, "whole Core size units");
        assertGe(got * 1e18, sold * ASK, "paid at least the ask");
        assertLe(got, usdcIn);
        assertGe(vault.totalAssets(), assets, "a fill never lowers share value");
    }

    function test_gas_aFillingBuyStaysFarUnderTheSmallBlockCap() public {
        uint256 g = gasleft();
        _buy(int256(CHUNK));
        uint256 used = g - gasleft();
        emit log_named_uint("filling buy, gas", used);
        assertLt(used, 1_000_000);
    }

    // ─── pass-through ─────────────────────────────────────────────────────

    function test_askAboveThePool_goesToTheCurve() public {
        _alignPool(CRASH_PX); // pool on the oracle, under the after-hours ask
        (uint256 capacity, uint256 ask,,) = hook.quote();
        assertEq(capacity, 0);
        assertGt(ask, UnwindLib.usdcPerNvdaxAt(_sqrtPrice(), nvdax0));

        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE, "the buyer never pays more than the curve");
    }

    function test_ownerPause_goesToTheCurve() public {
        vm.prank(owner);
        vault.pause();
        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE);
    }

    function test_driftedShort_goesToTheCurve() public {
        core.forcePosition(address(vault), -30_000, 30_000 * _raw(CRASH_PX));
        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE, "never sell stock the short doesn't cover");
    }

    function test_fillsDisabled_goesToTheCurve() public {
        Seiz3Hook.Settings memory s = hook.settings();
        s.fillsEnabled = false;
        vm.prank(owner);
        hook.setSettings(s);
        _buy(int256(1e18));
        assertEq(vault.inventory(), SEIZE);
    }

    function test_noInventory_goesToTheCurve() public {
        Seiz3Base.setUp(); // fresh vault, nothing taken
        _fundBuyer();
        core.setPx(_raw(CRASH_PX)); // the pool would be above the ask
        (uint256 capacity,,,) = hook.quote();
        assertEq(capacity, 0);
        _buy(int256(1e18));
        assertEq(nvdax.balanceOf(address(vault)), 0);
    }

    function test_hyperCoreReadsFail_theCurveStillWorks() public {
        core.setFailReads(true);
        uint256 stock = nvdax.balanceOf(buyer);
        _buy(int256(1e18));
        assertEq(nvdax.balanceOf(buyer) - stock, 1e18, "swap went through");
        core.setFailReads(false);
        assertEq(vault.inventory(), SEIZE, "nothing sold blind");
    }

    // ─── fees ─────────────────────────────────────────────────────────────

    function test_fee_wideAfterTheBellTightWhileOpen() public {
        uint256 snap = vm.snapshotState();
        uint256 closedOut = _sell(1e18);
        vm.revertToState(snap);
        vm.prank(owner);
        risk.setMarketOpen(true);
        uint256 openOut = _sell(1e18);
        assertApproxEqRel(closedOut, openOut * 9900 / 9970, 0.0005e18, "1% vs 0.3%");
    }

    function test_fee_followsTheCreMarketStatus() public {
        vm.prank(owner);
        risk.setMarketOpen(true);
        vm.prank(creForwarder);
        risk.onReport("", abi.encode(false, uint256(50_000e6), uint64(block.timestamp)));
        (,, uint24 fee, bool open) = hook.quote();
        assertFalse(open, "the Data Streams status replaces the owner's flag");
        assertEq(fee, 10_000);

        vm.prank(creForwarder);
        risk.onReport("", abi.encode(true, uint256(50_000e6), uint64(block.timestamp + 1)));
        (,, fee, open) = hook.quote();
        assertTrue(open);
        assertEq(fee, 3000);

        vm.warp(block.timestamp + risk.maxReportAge() + 2);
        (,, fee, open) = hook.quote();
        assertFalse(open, "a stale report prices as after hours");
        assertEq(fee, 10_000);
    }

    function test_unwindStep_paysTheOpenFeeEvenAfterTheBell() public {
        _alignPool(CRASH_PX); // market still closed
        uint256 idle = usdc.balanceOf(address(vault));
        vault.unwindStep();
        uint256 out = usdc.balanceOf(address(vault)) - idle;
        assertApproxEqRel(out, Units.value(CHUNK, CRASH_PX) * 997 / 1000, 0.001e18, "0.3%, not 1%");
    }

    // ─── access ───────────────────────────────────────────────────────────

    function test_onHookFill_onlyTheHook() public {
        vm.expectRevert(ISeiz3Vault.NotHook.selector);
        vault.onHookFill(1e18, 1000e6);
    }

    function test_onHookFill_neverBelowTheOracle() public {
        vm.prank(address(hook));
        vm.expectRevert(ISeiz3Vault.Slippage.selector);
        vault.onHookFill(1e18, 1);
    }

    function test_onHookFill_atMostMaxUnhedged() public {
        vm.prank(address(hook));
        vm.expectRevert(ISeiz3Vault.OverCap.selector);
        vault.onHookFill(CHUNK + 1e15, 1_000_000e6);
    }

    function test_beforeSwap_onlyThePoolManager() public {
        vm.expectRevert(Seiz3Hook.NotPoolManager.selector);
        hook.beforeSwap(
            address(this),
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0}),
            ""
        );
    }

    function test_initialize_onlyTheVaultsPool() public {
        PoolKey memory other = key;
        other.tickSpacing = 10;
        vm.expectRevert();
        seeder.initialize(other, UnwindLib.sqrtPriceAt(START_PX, nvdax0));

        PoolKey memory staticFee = key;
        staticFee.fee = 3000;
        vm.expectRevert();
        seeder.initialize(staticFee, UnwindLib.sqrtPriceAt(START_PX, nvdax0));
    }

    function test_setVault_once() public {
        vm.prank(owner);
        vm.expectRevert(Seiz3Hook.VaultAlreadySet.selector);
        hook.setVault(vault);
    }

    function test_setSettings_rejectsBadFees() public {
        Seiz3Hook.Settings memory s = hook.settings();
        s.feeClosed = 1_000_001;
        vm.prank(owner);
        vm.expectRevert(Seiz3Hook.BadSettings.selector);
        hook.setSettings(s);
    }
}
