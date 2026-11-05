// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";

/// @notice Frozen at hour 0–1. Keeper, API and replay build against this + the events below.
interface IAfterbellVault {
    struct Pending {
        int64 delta; // signed Core size of the unconfirmed order (negative = more short)
        uint64 sentBlock;
        uint64 sentAt;
        uint8 tries;
    }

    // ─── events ───────────────────────────────────────────────────────────
    event LiquidationTaken(
        bytes32 indexed liqId, address indexed borrower, uint256 seized, uint256 repaid, int64 sz, uint128 cloid
    );
    event HedgeSent(int64 delta, uint64 limitPx, bool reduceOnly, uint8 tries, uint128 cloid);
    event HedgeConfirmed(int64 actual, int64 target);
    event HedgeStuck(int64 gap);
    event Unwound(uint256 chunk, uint256 usdcOut);
    event MarginMoved(uint256 amount, bool toCore);
    event WithdrawQueued(address indexed lp, uint256 shares);
    event WithdrawClaimed(address indexed lp, uint256 shares, uint256 assets);
    event Paused(bool paused);

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

    // ─── keeper-facing ────────────────────────────────────────────────────
    function liquidate(MarketParams calldata params, address borrower, uint256 seized) external;
    function syncHedge() external;
    function unwindStep() external;
    function topUpMargin(uint256 amount) external;
    function withdrawMargin(uint256 amount) external;

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
}
