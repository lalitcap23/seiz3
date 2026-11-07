// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

import {SEIZ3_HOOK_FLAGS} from "../Seiz3Hook.sol";
import {RiskParams} from "../RiskParams.sol";
import {UnwindLib} from "../libs/UnwindLib.sol";
import {Units} from "../libs/Units.sol";
import {Seiz3VaultRemote} from "./Seiz3VaultRemote.sol";
import {HyperCoreGateway} from "./HyperCoreGateway.sol";

/// @title Seiz3HookRemote
/// @notice Seiz3Hook for Seiz3VaultRemote (Base Sepolia): the same hook, line for line, except that its two
///         HyperCore reads (the oracle price and the vault's short) come from the vault's HyperCoreGateway instead of
///         the precompiles. Same permissions (SEIZ3_HOOK_FLAGS), events and quote.
///         Uniswap v4 hook on the vault's NVDAx/USDC pool. Buyers of NVDAx are filled from the vault's hedged
///         inventory at the HyperCore oracle price plus a spread, off the curve (`beforeSwap` returns a delta), and
///         each fill queues the matching reduce-only buy on HyperCore through `Seiz3VaultRemote.onHookFill`. Whatever
///         the hook doesn't fill goes to the curve at a fee set by market hours: wide after the bell, tight while
///         the stock market is open.
/// @dev Fills follow `unwindStep`'s rules: no owner pause, no hedge in flight, the short within `maxUnhedged` of
///      −inventory, at most `maxUnhedged` per fill. A fill sets the vault's pending hedge, so the next one waits for
///      `syncHedge`. The hook only sells at its ask when the pool's own price is at or above it, so a buyer never
///      pays more than the curve's current price. It holds no tokens between swaps.
contract Seiz3HookRemote is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    uint256 internal constant BPS = 10_000;
    uint8 internal constant PAUSE_OWNER = 4; // Seiz3VaultRemote.PAUSE_OWNER

    uint160 public constant FLAGS = SEIZ3_HOOK_FLAGS;

    struct Settings {
        uint16 spreadOpenBps; // ask over the Core oracle while the stock market is open
        uint16 spreadClosedBps; // ask over the Core oracle after the bell
        uint24 feeOpen; // LP fee (pips) for curve swaps while open, and always for the vault's own sells
        uint24 feeClosed; // LP fee (pips) for everyone else's curve swaps after the bell
        bool fillsEnabled; // kill switch: false turns the hook into a plain dynamic-fee pool
    }

    IPoolManager public immutable poolManager;

    // set once by `setVault`
    Seiz3VaultRemote public vault;
    HyperCoreGateway public gateway; // the vault's: HyperCore's oracle and the vault's short
    PoolId public poolId;
    IERC20 public usdc;
    IERC20 public nvdax;
    bool public nvdaxIsCurrency0;
    uint32 public perpIndex;
    uint8 public szDecimals;

    Settings internal _s;

    event VaultSet(address vault, bytes32 poolId);
    event SettingsSet(Settings s);
    event InventoryFill(address indexed sender, uint256 nvdaxOut, uint256 usdcIn, uint256 ask, bool marketOpen);

    error NotPoolManager();
    error WrongPool();
    error VaultNotSet();
    error VaultAlreadySet();
    error BadVault();
    error BadSettings();
    error HookNotImplemented();

    constructor(IPoolManager poolManager_, address owner_) Ownable(owner_) {
        poolManager = poolManager_;
        Hooks.validateHookPermissions(IHooks(address(this)), permissions()); // reverts unless mined to FLAGS
        _setSettings(
            Settings({spreadOpenBps: 10, spreadClosedBps: 100, feeOpen: 3000, feeClosed: 10_000, fillsEnabled: true})
        );
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function permissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ═══ admin ═════════════════════════════════════════════════════════════

    /// @notice Bind the hook to its vault, once. The vault's pool key must already name this hook with a dynamic
    ///         fee; until this runs, the pool can't be initialised or swapped.
    function setVault(Seiz3VaultRemote v) external onlyOwner {
        if (address(vault) != address(0)) revert VaultAlreadySet();
        (Currency c0, Currency c1, uint24 fee, int24 tickSpacing, IHooks hooks) = v.poolKey();
        if (address(hooks) != address(this) || !fee.isDynamicFee() || address(v.poolManager()) != address(poolManager))
        {
            revert BadVault();
        }
        PoolKey memory key = PoolKey(c0, c1, fee, tickSpacing, hooks);
        vault = v;
        gateway = v.gateway();
        poolId = key.toId();
        usdc = v.usdc();
        nvdax = v.nvdax();
        nvdaxIsCurrency0 = v.nvdaxIsCurrency0();
        perpIndex = v.perpIndex();
        szDecimals = v.szDecimals();
        emit VaultSet(address(v), PoolId.unwrap(poolId));
    }

    function setSettings(Settings calldata s) external onlyOwner {
        _setSettings(s);
    }

    function settings() external view returns (Settings memory) {
        return _s;
    }

    // ═══ quote ═════════════════════════════════════════════════════════════

    /// @notice What a buyer would get from the vault right now.
    /// @return capacity NVDAx (18 dec) the hook would sell in one fill; 0 when fills are blocked or the pool
    ///                  trades below the ask
    /// @return ask      USDC (6 dec) per whole NVDAx the hook sells at: Core oracle × (1 + spread)
    /// @return fee      LP fee (pips) a non-vault curve swap pays now
    /// @return open     the stock market flag the spread and fee were picked from
    function quote() public view returns (uint256 capacity, uint256 ask, uint24 fee, bool open) {
        Seiz3VaultRemote v = vault;
        if (address(v) == address(0)) revert VaultNotSet();
        RiskParams risk = v.risk();
        open = risk.marketOpen();
        Settings memory s = _s;
        fee = open ? s.feeOpen : s.feeClosed;
        ask = Math.mulDiv(
            Units.pxToUsdc(_oraclePx(), szDecimals),
            BPS + (open ? s.spreadOpenBps : s.spreadClosedBps),
            BPS,
            Math.Rounding.Ceil
        );
        if (s.fillsEnabled) capacity = _capacity(v, risk.get(), ask);
    }

    /// @dev NVDAx the vault can sell at `ask` right now, on the Core size grid. `unwindStep`'s rules, plus the
    ///      pool's own price and the PoolManager's USDC.
    function _capacity(Seiz3VaultRemote v, RiskParams.Params memory r, uint256 ask) internal view returns (uint256) {
        if (v.pauseFlags() & PAUSE_OWNER != 0) return 0;
        (int64 pending,,,) = v.pendingHedge();
        uint256 inv = v.inventory();
        if (pending != 0 || inv == 0) return 0;

        // never sell stock the short doesn't cover (same check as `unwindStep`)
        int64 gap = -int64(Units.toCoreSize(inv, szDecimals)) - gateway.position(address(v), perpIndex).szi;
        if ((gap >= 0 ? uint64(gap) : uint64(-gap)) > r.maxUnhedged) return 0;

        // only sell at the ask when the curve is at or above it: the buyer never pays more than the pool's price
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (UnwindLib.usdcPerNvdaxAt(sqrtPriceX96, nvdaxIsCurrency0) < ask) return 0;

        uint256 cap = Math.min(inv, Units.fromCoreSize(r.maxUnhedged, szDecimals));
        // the hook pays the vault out of the PoolManager's USDC before the buyer settles, so it can't take more
        // than the PoolManager holds
        cap = Math.min(cap, Math.mulDiv(usdc.balanceOf(address(poolManager)), 1e18, ask));
        return _toCoreGrid(cap, szDecimals);
    }

    // ═══ hooks ═════════════════════════════════════════════════════════════

    /// @dev Only the vault's own pool may use this hook. Its id covers both tokens, the dynamic fee and tick spacing.
    function beforeInitialize(address, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (address(vault) == address(0)) revert VaultNotSet();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool();

        uint256 capacity;
        uint256 ask;
        uint24 fee;
        bool open;
        // a failed HyperCore read (a stale gateway) must not brick the pool: fall back to a plain curve swap at the closed fee
        try this.quote() returns (uint256 c, uint256 a, uint24 f, bool o) {
            (capacity, ask, fee, open) = (c, a, f, o);
        } catch {
            fee = _s.feeClosed;
        }
        if (sender == address(vault)) fee = _s.feeOpen; // the vault's own push sells (unwindStep) pay the open fee

        // a buy of NVDAx pays the other currency in: zeroForOne when NVDAx is currency1
        BeforeSwapDelta delta = BeforeSwapDeltaLibrary.ZERO_DELTA;
        if (params.zeroForOne != nvdaxIsCurrency0 && capacity != 0) {
            delta = _fill(sender, params.amountSpecified, capacity, ask, open);
        }
        return (IHooks.beforeSwap.selector, delta, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Sell up to `capacity` NVDAx at `ask` for the specified side of the swap; zero delta if that rounds to
    ///      nothing. Whatever isn't filled here goes to the curve.
    function _fill(address sender, int256 amountSpecified, uint256 capacity, uint256 ask, bool open)
        internal
        returns (BeforeSwapDelta)
    {
        bool exactIn = amountSpecified < 0;
        uint256 nvdaxOut = exactIn
            ? Math.mulDiv(uint256(-amountSpecified), 1e18, ask)  // USDC in → NVDAx at the ask, rounded down
            : uint256(amountSpecified);
        nvdaxOut = _toCoreGrid(Math.min(nvdaxOut, capacity), szDecimals); // whole Core units: the buy-back is exact
        if (nvdaxOut == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        uint256 usdcIn = Math.mulDiv(nvdaxOut, ask, 1e18, Math.Rounding.Ceil); // ≤ the exact-in amount by construction

        // pay the vault from the PoolManager, then move the stock from the vault into it; the buyer's own
        // settlement after the swap closes both deltas
        Seiz3VaultRemote v = vault;
        poolManager.take(Currency.wrap(address(usdc)), address(v), usdcIn);
        poolManager.sync(Currency.wrap(address(nvdax)));
        v.onHookFill(nvdaxOut, usdcIn);
        poolManager.settle();
        emit InventoryFill(sender, nvdaxOut, usdcIn, ask, open);

        // positive = the hook took that currency, negative = the hook sent it (IHooks.beforeSwap)
        return exactIn
            ? toBeforeSwapDelta(int128(int256(usdcIn)), -int128(int256(nvdaxOut)))
            : toBeforeSwapDelta(-int128(int256(nvdaxOut)), int128(int256(usdcIn)));
    }

    // ─── callbacks this hook's address doesn't enable (PoolManager never calls them) ───

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ═══ internals ═════════════════════════════════════════════════════════

    function _setSettings(Settings memory s) internal {
        if (s.spreadOpenBps >= BPS || s.spreadClosedBps >= BPS || !s.feeOpen.isValid() || !s.feeClosed.isValid()) {
            revert BadSettings();
        }
        _s = s;
        emit SettingsSet(s);
    }

    /// @dev The Core oracle through the gateway; 0 means unknown, as with the precompile.
    function _oraclePx() internal view returns (uint64 px) {
        px = gateway.oraclePx(perpIndex);
        if (px == 0) revert HyperCoreGateway.UnknownAsset(perpIndex);
    }

    /// @dev Round NVDAx (18 dec) down to whole Core size units.
    function _toCoreGrid(uint256 nvdaxAmount, uint8 dec) internal pure returns (uint256) {
        return Units.fromCoreSize(Units.toCoreSize(nvdaxAmount, dec), dec);
    }
}
