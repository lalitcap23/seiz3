// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {AfterbellBase, MockUSDC} from "../utils/AfterbellBase.sol";
import {MockHyperCore} from "../utils/MockHyperCore.sol";
import {AfterbellVault} from "../../src/AfterbellVault.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {DemoOracle} from "../../src/mocks/DemoOracle.sol";
import {UnwindLib} from "../../src/libs/UnwindLib.sol";
import {Units} from "../../src/libs/Units.sol";

/// @dev Everything the handler drives, wired up by the test.
struct Refs {
    AfterbellVault vault;
    MockHyperCore core;
    IMorpho morpho;
    MarketParams market;
    DemoOracle oracle;
    MockNVDAx nvdax;
    MockUSDC usdc;
    IPoolManager pm;
    PoolKey key;
    bool nvdax0;
    PoolSwapTest router;
    RiskParams risk;
    address owner;
}

/// @notice Drives random sequences of liquidations, syncs, unwinds, hook buys, price moves, partial fills and
///         dropped orders. Ghost-checks the state right after every successful sync and every hook fill.
contract VaultHandler is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    AfterbellVault internal vault;
    MockHyperCore internal core;
    IMorpho internal morpho;
    MarketParams internal market;
    DemoOracle internal oracle;
    MockNVDAx internal nvdax;
    MockUSDC internal usdc;
    IPoolManager internal pm;
    PoolKey internal key;
    bool internal nvdax0;
    PoolSwapTest internal router;
    RiskParams internal risk;
    address internal owner;

    uint256 public px = 217.15e6;
    uint256 public borrowers;
    uint256 public liquidations;
    uint256 public confirmedSyncs;
    uint256 public unwinds;
    uint256 public hookFills;
    uint256 public badSyncs; // a confirmed sync left Core off target
    uint256 public badFills; // a hook fill paid the vault less than the oracle value, or lowered totalAssets

    constructor(Refs memory r) {
        vault = r.vault;
        core = r.core;
        morpho = r.morpho;
        market = r.market;
        oracle = r.oracle;
        nvdax = r.nvdax;
        usdc = r.usdc;
        pm = r.pm;
        key = r.key;
        nvdax0 = r.nvdax0;
        router = r.router;
        risk = r.risk;
        owner = r.owner;
    }

    // ─── actions ──────────────────────────────────────────────────────────

    function liquidate(uint256 collSeed) external {
        (int64 pending,,,) = vault.pendingHedge();
        if (pending != 0 || vault.paused()) return; // it would revert; don't burn a price crash on it
        if (px < 120e6) _movePrice(217.15e6); // keep prices sane over long runs
        uint256 collateral = bound(collSeed, 2e18, 30e18);
        address b = address(uint160(0xB0000 + ++borrowers));
        vm.prank(owner);
        nvdax.mint(b, collateral);
        uint256 debt = Units.value(collateral, px) * 7600 / 10_000;
        vm.startPrank(b);
        nvdax.approve(address(morpho), collateral);
        morpho.supplyCollateral(market, collateral, b, "");
        morpho.borrow(market, debt, 0, b, b);
        vm.stopPrank();

        _movePrice(px * 90 / 100);
        try vault.liquidate(market, b, collateral / 2) {
            ++liquidations;
        } catch {}
    }

    function sync(uint8 secs) external {
        _nextBlock(bound(secs, 1, 20));
        try vault.syncHedge() {
            (int64 delta,,,) = vault.pendingHedge();
            if (delta == 0) {
                ++confirmedSyncs;
                int64 actual = core.szi(address(vault));
                uint64 inv = Units.toCoreSize(vault.inventory(), 3);
                int256 gap = int256(uint256(inv)) + actual;
                bool ok = inv == 0 ? actual == 0 : (gap < 0 ? -gap : gap) <= int256(uint256(risk.get().maxUnhedged));
                if (!ok) ++badSyncs;
            }
        } catch {}
    }

    function unwind() external {
        vm.warp(block.timestamp + 11);
        try vault.unwindStep() {
            ++unwinds;
        } catch {}
    }

    /// @dev Weekend buyers bid the token over the vault's ask on the curve, then buy more: the hook fills that
    ///      from inventory whenever it may.
    function buy(uint256 sizeSeed, bool exactOut) external {
        uint160 above = UnwindLib.sqrtPriceAt(px * 10_050 / 10_000, nvdax0);
        (uint160 current,,,) = pm.getSlot0(key.toId());
        bool buyDir = !nvdax0; // paying USDC in
        if (above != current) _swap(above < current, -1e30, above);

        uint256 inv = vault.inventory();
        uint256 idle = usdc.balanceOf(address(vault));
        uint256 assets = vault.totalAssets();
        int256 amount = exactOut ? int256(bound(sizeSeed, 1e15, 5e18)) : -int256(bound(sizeSeed, 1e6, 1000e6));
        _swap(buyDir, amount, buyDir ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);

        uint256 sold = inv - vault.inventory();
        if (sold == 0) return;
        ++hookFills;
        uint256 got = usdc.balanceOf(address(vault)) - idle;
        if (got < Units.value(sold, px) || vault.totalAssets() < assets) ++badFills;
    }

    /// @dev Thin books fill part of an order; a full book fills it all (the common case).
    function fills(uint16 bps) external {
        uint256 b = bound(bps, 0, 14_000);
        core.setFillBps(uint16(b > 10_000 ? 10_000 : b));
    }

    function drops(uint8 n) external {
        core.setDropNext(bound(n, 0, 2));
    }

    function price(uint256 bpsSeed, bool up) external {
        uint256 bps = bound(bpsSeed, 1, 500);
        if (px > 300e6) up = false; // stay inside the pool's range
        _movePrice(up ? px * (10_000 + bps) / 10_000 : px * (10_000 - bps) / 10_000);
    }

    /// @dev Owner tops up to the target (current short + one max liquidation), as the keeper would pre-fund.
    function topUp() external {
        uint256 have = core.accountValue(address(vault));
        uint256 target = vault.marginTarget();
        uint256 amount = target > have ? target - have : 0;
        uint256 idle = usdc.balanceOf(address(vault));
        if (amount > idle / 2) amount = idle / 2;
        if (amount == 0) return;
        vm.prank(owner);
        try vault.topUpMargin(amount) {} catch {}
    }

    // ─── plumbing ─────────────────────────────────────────────────────────

    function _nextBlock(uint256 secs) internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + secs);
        core.processBlock();
    }

    /// @dev Move the lending oracle, Core oracle/mark and the pool together (arbitrageurs are fast).
    function _movePrice(uint256 usd6) internal {
        px = usd6;
        vm.prank(owner);
        oracle.setPrice(usd6 * 1e18);
        core.setPx(uint64(usd6 / 1e3));
        uint160 target = UnwindLib.sqrtPriceAt(usd6, nvdax0);
        (uint160 current,,,) = pm.getSlot0(key.toId());
        if (target == current) return;
        _swap(target < current, -1e30, target);
    }

    function _swap(bool zeroForOne, int256 amountSpecified, uint160 limit) internal {
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}

contract HedgeInvariantTest is AfterbellBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        risk.setMarketOpen(true);
        _addLiquidity(5_000_000e6, 6000, bytes32(uint256(1))); // ±60% so price walks never leave the pool
        handler = new VaultHandler(
            Refs(vault, core, morpho, market, oracle, nvdax, usdc, pm, key, nvdax0, swapRouter, risk, owner)
        );

        // the handler arbitrages the pool, so it needs deep pockets
        usdc.mint(address(handler), 100_000_000e6);
        _mintNvdax(address(handler), 1_000_000e18);
        vm.startPrank(address(handler));
        usdc.approve(address(swapRouter), type(uint256).max);
        nvdax.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        targetContract(address(handler));
    }

    /// @dev The design invariant, from the vault's own books: confirmed + pending covers inventory.
    function invariant_pendingCoversInventory() public view {
        (int64 delta,,,) = vault.pendingHedge();
        int256 net = int256(uint256(Units.toCoreSize(vault.inventory(), SZ_DEC))) + vault.confirmedShort() + delta;
        uint256 absNet = uint256(net < 0 ? -net : net);
        assertTrue(absNet <= _risk().maxUnhedged || vault.paused(), "|inventory + short + pending| > maxUnhedged");
    }

    function invariant_confirmedSyncsMatchCore() public view {
        assertEq(handler.badSyncs(), 0);
    }

    function invariant_neverLongOnCore() public view {
        assertLe(core.szi(address(vault)), 0);
    }

    function invariant_inventoryIsBacked() public view {
        assertGe(nvdax.balanceOf(address(vault)), vault.inventory());
    }

    function invariant_hookFillsAtOrAboveTheOracle() public view {
        assertEq(handler.badFills(), 0);
    }

    function afterInvariant() external {
        // keep the run honest: make sure the interesting paths were actually exercised
        emit log_named_uint("liquidations", handler.liquidations());
        emit log_named_uint("confirmed syncs", handler.confirmedSyncs());
        emit log_named_uint("unwinds", handler.unwinds());
        emit log_named_uint("hook fills", handler.hookFills());
    }
}
