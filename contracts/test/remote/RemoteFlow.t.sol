// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HLConstants} from "@hyper-evm-lib/src/common/HLConstants.sol";

import {ISeiz3Vault} from "../../src/interfaces/ISeiz3Vault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {HedgeLib} from "../../src/libs/HedgeLib.sol";
import {Units} from "../../src/libs/Units.sol";
import {HyperCoreGateway} from "../../src/remote/HyperCoreGateway.sol";
import {Seiz3VaultRemote} from "../../src/remote/Seiz3VaultRemote.sol";
import {Seiz3HookRemote} from "../../src/remote/Seiz3HookRemote.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";
import {RemoteBase} from "./RemoteBase.sol";

/// @notice The whole round on the Base Sepolia architecture: liquidate on this chain → the relayer shorts on HyperCore
///         → syncHedge confirms through the gateway → buyers through the hook and unwind chunks into the pool, each
///         buy-back relayed and confirmed → flat.
contract RemoteFlowTest is RemoteBase {
    address internal buyer = makeAddr("buyer");

    function _fundBuyer() internal {
        usdc.mint(buyer, 1_000_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev USDC → NVDAx, exact NVDAx out.
    function _buy(uint256 nvdaxOut) internal {
        bool zeroForOne = !nvdax0;
        vm.prank(buyer);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(nvdaxOut),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ─── the chain has no HyperCore ───────────────────────────────────────

    function test_setUp_noHyperCoreOnThisChain() public view {
        assertEq(HLConstants.ORACLE_PX_PRECOMPILE_ADDRESS.code.length, 0);
        assertEq(HLConstants.POSITION2_PRECOMPILE_ADDRESS.code.length, 0);
        assertEq(HLConstants.ACCOUNT_MARGIN_SUMMARY_PRECOMPILE_ADDRESS.code.length, 0);
        assertEq(address(0x3333333333333333333333333333333333333333).code.length, 0, "no CoreWriter");
        assertEq(vault.coreDepositWallet(), address(gateway));
    }

    function test_setUp_countsTheHedgeAccountOnHyperCore() public view {
        assertTrue(vault.coreFunded());
        assertEq(vault.coreUsdc(), CORE_MARGIN);
        assertEq(vault.totalAssets(), LP_DEPOSIT + CORE_MARGIN);
        assertEq(vault.inTransit(), 0);
    }

    // ─── liquidate → relayer → sync ───────────────────────────────────────

    function test_liquidate_queuesTheShortOnTheGateway() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);

        assertEq(vault.inventory(), SEIZE);
        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, -40_000);
        assertEq(tries, 1);

        assertEq(gateway.actionCount(), 1);
        HyperCoreGateway.Order memory o = gateway.orders(1);
        assertEq(o.asset, PERP_ASSET);
        assertFalse(o.isBuy);
        assertFalse(o.reduceOnly, "a sell opens the short");
        assertEq(o.sz, 40_000 * 1e5, "wire size");
        assertEq(o.tif, HLConstants.LIMIT_ORDER_TIF_IOC);
        assertEq(o.cloid, HedgeLib.makeCloid(vault.hedgeId(), 1));
        assertTrue(core.validWirePx(o.limitPx), "on Hyperliquid's price grid");
        assertFalse(gateway.settled());
        assertEq(core.orderCount(), 0, "nothing reaches HyperCore without the relayer");
    }

    function test_syncHedge_waitsForTheRelayer() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        _nextBlock(60); // long past orderDelaySec
        _post(0); // a heartbeat that doesn't acknowledge the order

        assertFalse(vault.canSync());
        vm.prank(keeper);
        vm.expectRevert(ISeiz3Vault.TooEarly.selector);
        vault.syncHedge();

        _relay();
        assertTrue(vault.canSync());
        vm.expectEmit(address(vault));
        emit ISeiz3Vault.HedgeConfirmed(-40_000, -40_000);
        _sync();

        assertEq(vault.confirmedShort(), -40_000);
        assertEq(core.szi(hedge), -40_000, "the hedge account holds the short");
        assertEq(core.lastOrder().cloid, HedgeLib.makeCloid(vault.hedgeId(), 1), "placed with the vault's cloid");
        assertEq(uint8(vault.hedgeState()), uint8(ISeiz3Vault.HedgeState.Idle));
        assertEq(vault.pauseFlags(), 0);
    }

    function test_syncHedge_resendsADroppedOrder() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        core.setDropNext(1); // HyperCore rejects the first order
        _relay();
        _sync();

        (int64 delta, uint8 tries) = _pending();
        assertEq(delta, -40_000);
        assertEq(tries, 2);
        assertEq(gateway.actionCount(), 2);
        assertFalse(gateway.settled());

        _relay();
        _sync();
        assertEq(vault.confirmedShort(), -40_000);
        assertEq(uint8(vault.hedgeState()), uint8(ISeiz3Vault.HedgeState.Idle));
    }

    function test_syncHedge_pausesAfterMaxTries() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);
        core.setDropNext(10);
        for (uint256 i; i < 3; ++i) {
            _relay();
            _sync();
        }
        assertEq(vault.pauseFlags() & vault.PAUSE_HEDGE(), vault.PAUSE_HEDGE());
        assertEq(uint8(vault.hedgeState()), uint8(ISeiz3Vault.HedgeState.Paused));
    }

    // ─── stock leaves the vault: hook fills and unwinds ───────────────────

    function test_hookFill_sellsToABuyerAndTheBuyBackIsRelayed() public {
        _takeAndHedge(); // weekend pool at $217, above the after-hours ask (crash × 1.01)
        _fundBuyer();
        (uint256 capacity, uint256 ask,, bool open) = hook.quote();
        assertFalse(open);
        assertEq(ask, 197.3843e6, "Core oracle + 1% after the bell");
        assertEq(capacity, 2e18, "one fill is at most maxUnhedged");

        uint256 idle = usdc.balanceOf(address(vault));
        vm.expectEmit(address(hook));
        emit Seiz3HookRemote.InventoryFill(address(swapRouter), 1.5e18, 1.5e18 * ask / 1e18, ask, false);
        _buy(1.5e18);

        assertEq(nvdax.balanceOf(buyer), 1.5e18);
        assertEq(usdc.balanceOf(address(vault)) - idle, 1.5e18 * ask / 1e18, "the vault got the ask");
        assertEq(vault.inventory(), SEIZE - 1.5e18);
        (int64 delta,) = _pending();
        assertEq(delta, 1500, "buy back the short the sold stock no longer needs");
        HyperCoreGateway.Order memory o = gateway.orders(gateway.actionCount());
        assertTrue(o.isBuy && o.reduceOnly);
        (capacity,,,) = hook.quote();
        assertEq(capacity, 0, "the next buyer waits for the buy-back");

        _relay();
        _sync();
        assertEq(vault.confirmedShort(), -38_500);
        assertEq(core.szi(hedge), -38_500);
        (capacity,,,) = hook.quote();
        assertGt(capacity, 0, "fills resume once the buy-back is confirmed");
    }

    function test_unwind_toFlat() public {
        _takeAndHedge();
        _alignPool(CRASH_PX); // Monday: arbitrage puts the pool back on the oracle
        vm.prank(owner);
        risk.setMarketOpen(true);
        uint256 valueBefore = vault.totalAssets();

        uint256 steps;
        while (vault.inventory() != 0) {
            vm.warp(block.timestamp + 10); // cooldown while open
            vm.prank(keeper);
            vault.unwindStep();
            _relay();
            _sync();
            ++steps;
            require(steps < 50, "unwind did not converge");
        }

        assertEq(steps, 20, "40 NVDA in 2 NVDA chunks");
        assertEq(vault.confirmedShort(), 0);
        assertEq(core.szi(hedge), 0, "short closed on HyperCore");
        assertEq(uint8(vault.hedgeState()), uint8(ISeiz3Vault.HedgeState.Idle));
        assertEq(gateway.actionCount(), 21, "the short + one buy-back per chunk");
        // pool fee + impact on the way out, nothing else
        assertApproxEqRel(vault.totalAssets(), valueBefore, 0.01e18);
    }

    function test_unwind_neverSellsStockTheShortDoesNotCover() public {
        _takeAndHedge();
        _alignPool(CRASH_PX);
        vm.prank(owner);
        risk.setMarketOpen(true);
        core.forcePosition(hedge, -30_000, 30_000 * _raw(CRASH_PX)); // HyperCore liquidated part of the short
        _post(gateway.executedNonce());

        vm.warp(block.timestamp + 10);
        vm.expectRevert(ISeiz3Vault.HedgeDrift.selector);
        vault.unwindStep();

        _sync(); // drift found while idle: a new hedge cycle tops the short back up
        (int64 delta,) = _pending();
        assertEq(delta, -10_000);
        _relay();
        _sync();
        assertEq(vault.confirmedShort(), -40_000);
    }

    // ─── fail closed ──────────────────────────────────────────────────────

    function test_staleGateway_failsClosed() public {
        _takeAndHedge();
        _fundBuyer();
        vm.warp(block.timestamp + gateway.maxStateAge() + 1);

        vm.expectRevert();
        vault.totalAssets();
        vm.expectRevert();
        vault.syncHedge();
        vm.expectRevert();
        hook.quote();

        // the pool still trades, through the curve only
        uint256 inv = vault.inventory();
        _buy(0.1e18);
        assertEq(vault.inventory(), inv, "nothing sold from the vault on stale HyperCore state");
        assertEq(nvdax.balanceOf(buyer), 0.1e18);
    }

    function test_staleGateway_blocksLiquidation() public {
        vm.prank(owner);
        oracle.setPrice(CRASH_PX * 1e18);
        vm.warp(block.timestamp + gateway.maxStateAge() + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreGateway.StaleState.selector, gateway.lastSnapshot().observedAt));
        vault.liquidate(market, borrower, SEIZE);
    }

    // ─── CRE attestation ──────────────────────────────────────────────────

    function test_creSnapshot_updatesStateButNeverAcknowledgesOrders() public {
        _setPrice(CRASH_PX);
        _liquidate(SEIZE);

        // the relayer placed the order but its acknowledgement hasn't landed; the DON reports the fill
        uint64 n = gateway.actionCount();
        HyperCoreGateway.Order memory o = gateway.orders(n);
        vm.prank(core.CORE_WRITER());
        core.enqueue(
            hedge,
            abi.encodePacked(
                uint8(1),
                HLConstants.LIMIT_ORDER_ACTION,
                abi.encode(o.asset, o.isBuy, o.limitPx, o.sz, o.reduceOnly, o.tif, o.cloid)
            )
        );
        core.processBlock();
        _nextBlock(5);
        HyperCoreGateway.Snapshot memory s = _snapshot(n); // executedNonce = n, which the CRE path must ignore
        vm.prank(creForwarder);
        gateway.onReport("", abi.encode(s));

        assertEq(gateway.lastSnapshot().szi, -40_000, "state from the DON");
        assertEq(gateway.executedNonce(), 0, "only the relayer acknowledges orders");
        assertFalse(gateway.settled());
        vm.expectRevert(ISeiz3Vault.TooEarly.selector);
        vault.syncHedge();

        // the relayer's late acknowledgement of the same observation: ignored as state, counted as an ack
        vm.prank(relayer);
        gateway.relay(s);
        assertEq(gateway.executedNonce(), n);
        assertTrue(gateway.settled());
        _sync();
        assertEq(vault.confirmedShort(), -40_000);
    }

    // ─── what this chain can't do ─────────────────────────────────────────

    function test_marginMoves_haveNoBridge() public {
        vm.startPrank(owner);
        vm.expectRevert(Seiz3VaultRemote.NoBridge.selector);
        vault.topUpMargin(1e6);
        vm.expectRevert(Seiz3VaultRemote.NoBridge.selector);
        vault.withdrawMargin(1e6);
        vm.expectRevert(Seiz3VaultRemote.NoBridge.selector);
        vault.sweepSpotToDex();
        vm.expectRevert(Seiz3VaultRemote.NoBridge.selector);
        vault.addApiWallet(address(1), "x");
        vm.expectRevert(Seiz3VaultRemote.NoBridge.selector);
        vault.setMarginDepositDex(DEX);
        vm.stopPrank();
    }

    function test_activateCore_needsTheHedgeAccountOnHyperCore() public {
        HyperCoreGateway g = new HyperCoreGateway(owner, creForwarder, relayer, PERP_INDEX, DEX);
        Seiz3VaultRemote.Wiring memory w = Seiz3VaultRemote.Wiring({
            usdc: IERC20(address(usdc)),
            nvdax: IERC20(address(nvdax)),
            morpho: morpho,
            poolManager: pm,
            poolKey: key,
            risk: risk,
            gateway: g,
            perpAsset: PERP_ASSET,
            perpDexIndex: DEX,
            szDecimals: SZ_DEC
        });
        Seiz3VaultRemote v = new Seiz3VaultRemote(owner, w);
        vm.startPrank(owner);
        g.setAccount(address(v));
        vm.expectRevert(ISeiz3Vault.CoreAccountMissing.selector);
        v.activateCore(0);
        vm.stopPrank();
        assertEq(v.coreUsdc(), 0, "nothing counted before activation");
    }

    function test_constructor_rejectsAGatewayForAnotherPerp() public {
        HyperCoreGateway g = new HyperCoreGateway(owner, creForwarder, relayer, PERP_INDEX + 1, DEX);
        Seiz3VaultRemote.Wiring memory w = Seiz3VaultRemote.Wiring({
            usdc: IERC20(address(usdc)),
            nvdax: IERC20(address(nvdax)),
            morpho: morpho,
            poolManager: pm,
            poolKey: key,
            risk: risk,
            gateway: g,
            perpAsset: PERP_ASSET,
            perpDexIndex: DEX,
            szDecimals: SZ_DEC
        });
        vm.expectRevert(ISeiz3Vault.BadWiring.selector);
        new Seiz3VaultRemote(owner, w);
    }

    // ─── margin ───────────────────────────────────────────────────────────

    function test_lowMarginOnHyperCore_pausesAndBlocksLiquidations() public {
        _takeAndHedge();
        core.forceDexBalance(hedge, 100e6); // the hedge account lost most of its margin
        _post(gateway.executedNonce());
        _sync();
        assertEq(vault.pauseFlags() & vault.PAUSE_MARGIN(), vault.PAUSE_MARGIN());
        assertGt(vault.marginShortfall(), 0);

        core.forceDexBalance(hedge, CORE_MARGIN); // funded again on HyperCore
        _post(gateway.executedNonce());
        _sync();
        assertEq(vault.pauseFlags(), 0);
        assertEq(vault.marginShortfall(), 0);
    }

    function test_lp_withdrawQueueStillWorks() public {
        _takeAndHedge();
        uint256 shares = vault.balanceOf(lp);
        vm.prank(lp);
        vault.requestWithdraw(shares);
        assertGt(vault.queued(lp), 0, "more than idle USDC: queued");
        assertEq(Units.toCoreSize(vault.inventory(), SZ_DEC), 40_000);
    }

    function test_riskParams_crePathUnchanged() public {
        vm.prank(creForwarder);
        risk.onReport("", abi.encode(true, uint256(1_000e6), uint64(block.timestamp)));
        assertTrue(risk.marketOpen());
        RiskParams.Params memory p = risk.get();
        assertEq(p.maxLiquidation, 1_000e6);
    }

    function test_mockHyperCore_isOnlyReachedThroughTheRelayer() public {
        _takeAndHedge();
        MockHyperCore.Order memory o = core.lastOrder();
        assertEq(o.sender, hedge, "orders come from the hedge account, not the vault");
        assertEq(core.szi(address(vault)), 0);
    }
}
