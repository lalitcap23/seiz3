// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";

/// @notice Frozen at hour 0–1. Keeper, API and replay build against this + the events below.
///         Additions since the freeze are append-only (new views, events and errors); nothing was renamed.
interface IAfterbellVault {
    struct Pending {
        int64 delta; // signed Core size of the unconfirmed order (negative = more short)
        uint64 sentBlock;
        uint64 sentAt;
        uint8 tries;
    }

    /// @dev Matches `hedgeStateSchema` in packages/shared.
    enum HedgeState {
        Idle,
        Pending,
        Retrying,
        Paused
    }

    // ─── events ───────────────────────────────────────────────────────────
    event LiquidationTaken(
        bytes32 indexed liqId, address indexed borrower, uint256 seized, uint256 repaid, int64 sz, uint128 cloid
    );
    /// @param limitPx wire price (human × 1e8) actually sent to CoreWriter
    event HedgeSent(int64 delta, uint64 limitPx, bool reduceOnly, uint8 tries, uint128 cloid);
    event HedgeConfirmed(int64 actual, int64 target);
    event HedgeStuck(int64 gap);
    event Unwound(uint256 chunk, uint256 usdcOut);
    event MarginMoved(uint256 amount, bool toCore);
    event WithdrawQueued(address indexed lp, uint256 shares);
    event WithdrawClaimed(address indexed lp, uint256 shares, uint256 assets);
    event Paused(bool paused);
    // added after the freeze
    event MarginChecked(uint256 accountValue, uint256 required, bool ok);
    event CoreUsdcSwept(uint64 amountWei);
    event MarketAllowed(bytes32 indexed marketId, bool allowed);
    event RiskSet(address risk);
    event MarginDepositDexSet(uint32 dex);
    event ApiWalletAdded(address wallet, string name);

    // ─── errors ───────────────────────────────────────────────────────────
    error VaultPaused();
    error HedgePending();
    error OverCap();
    error LowMargin();
    error OracleBand();
    error DiscountTooLow();
    error NotMorpho();
    error NotInLiquidation();
    error NotPoolManager();
    error SameBlock();
    error TooEarly();
    error Cooldown();
    error NoInventory();
    error Slippage();
    error NothingToClaim();
    error ExceedsIdle();
    // added after the freeze
    error BadWiring();
    error MarketNotAllowed();
    error BadMarket();
    error ZeroAmount();
    error ZeroSize();
    error CoreAccountMissing();
    error NotInUnwind();
    error HedgeDrift();
    error NothingSold();
    error NotFlat();
    error ExceedsCore();
    error ExceedsBalance();
    error OverTarget();
    error BadDex();
    error NotRescuable();
    error NotHook();

    // ─── keeper-facing ────────────────────────────────────────────────────
    function liquidate(MarketParams calldata params, address borrower, uint256 seized) external;
    function syncHedge() external;
    function unwindStep() external;

    // ─── hook-facing (AfterbellHook, the pool key's hook) ─────────────────
    function onHookFill(uint256 sold, uint256 usdcIn) external;
    function topUpMargin(uint256 amount) external;
    function withdrawMargin(uint256 amount) external;
    function sweepSpotToDex() external;

    // ─── LP-facing (on top of ERC-4626) ───────────────────────────────────
    function requestWithdraw(uint256 shares) external;
    function claimQueued() external;

    // ─── views ────────────────────────────────────────────────────────────
    function inventory() external view returns (uint256);
    function confirmedShort() external view returns (int64);
    function pendingHedge() external view returns (int64 delta, uint64 sentBlock, uint64 sentAt, uint8 tries);
    function marginFloat() external view returns (uint256);
    function inTransit() external view returns (uint256);
    function paused() external view returns (bool);
    function lastUnwindAt() external view returns (uint64);
    function queuedShares() external view returns (uint256);
    function queued(address lp) external view returns (uint256);
    function perpAsset() external view returns (uint32);
    function perpDexIndex() external view returns (uint32);
    // added after the freeze
    function perpIndex() external view returns (uint32);
    function szDecimals() external view returns (uint8);
    function pauseFlags() external view returns (uint8);
    function hedgeId() external view returns (bytes32);
    function hedgeState() external view returns (HedgeState);
    function canSync() external view returns (bool);
    function coreUsdc() external view returns (uint256);
    function marginShortfall() external view returns (uint256);
    function marginTarget() external view returns (uint256);
    function instantLiquidity() external view returns (uint256);
}
