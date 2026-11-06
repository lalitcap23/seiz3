// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";
import {ReceiverTemplate} from "../cre/ReceiverTemplate.sol";

/// @title HyperCoreGateway
/// @notice HyperCore's read precompiles and CoreWriter, for a vault on an EVM chain that has neither (Base Sepolia).
///         The vault's short lives on HyperCore in a hedge account the relayer controls; this contract is the vault's
///         only view of it and its only way to trade it.
///
///         Writes: the vault's IOC orders are stored and numbered (`orders`, `actionCount`). The relayer places each
///         one on HyperCore from the hedge account, with the vault's cloid, and acknowledges it in the next snapshot.
///
///         Reads: the same shapes as the precompiles (`position`, `oraclePx`, `accountMarginSummary`, …), served from
///         the last snapshot of the hedge account. Two sources post snapshots and the newest one wins:
///           - the relayer (`relay`), after every order and on a heartbeat;
///           - the Chainlink CRE workflow (`onReport` through the forwarder), an independent DON-signed observation.
///         A snapshot older than `maxStateAge` makes every read revert, like a failed precompile read, so the vault
///         fails closed (no liquidations, no share pricing) instead of acting on stale HyperCore state.
///
///         `settled()`: every order has been acknowledged, so the last snapshot already shows its fill (or its
///         rejection). The vault's `syncHedge` waits for it instead of guessing an order delay.
/// @dev One vault (`account`), one perp. Reads for any other user return an empty account, like HyperCore does for an
///      address it has never seen. Report wire format: `abi.encode(Snapshot)`.
contract HyperCoreGateway is ReceiverTemplate {
    /// @notice One observation of the hedge account on HyperCore. Units follow the precompiles.
    struct Snapshot {
        uint64 observedAt; // unix seconds, HyperCore's clock (`clearinghouseState.time`)
        int64 szi; // position, Core size units (negative = short)
        uint64 entryNtl; // USD 6 dec
        int64 accountValue; // USD 6 dec on `perpDexIndex`, uPnL included
        uint64 marginUsed; // USD 6 dec
        uint64 ntlPos; // USD 6 dec
        uint64 spotUsdcWei; // spot USDC, 8 dec
        uint64 oraclePx; // raw perp px: 6 − szDecimals decimals
        uint64 markPx; // raw perp px
        uint32 leverage;
        bool exists; // the hedge account exists on HyperCore
        uint64 executedNonce; // relayer only: every order up to this nonce has been sent to HyperCore
    }

    /// @notice One vault order, as CoreWriter's limit-order action would carry it.
    struct Order {
        uint32 asset; // order asset id (HIP-3: 100000 + dex × 10000 + index)
        bool isBuy;
        uint64 limitPx; // wire price (human × 1e8)
        uint64 sz; // wire size (human × 1e8)
        bool reduceOnly;
        uint8 tif; // 3 = IOC
        uint128 cloid;
        uint64 requestedAt; // block timestamp of the request
    }

    uint8 public constant TIF_IOC = 3;
    /// @dev How far ahead of the block a snapshot's observation may be (HyperCore's clock vs block time).
    uint256 internal constant MAX_CLOCK_SKEW = 60;

    uint32 public immutable perpIndex; // precompile read id: perpDexIndex × 10000 + index
    uint32 public immutable perpDexIndex;

    address public account; // the vault: the only sender of orders, and the user the snapshots describe
    address public hedgeAccount; // the HyperCore address that holds the short (informational: relayer, API, CRE)
    address public relayer;
    uint32 public maxStateAge = 120;

    Snapshot internal _last;
    uint64 public actionCount; // orders requested so far; nonces run from 1
    uint64 public executedNonce; // orders acknowledged by the relayer
    uint64 public executedAt; // observedAt of the snapshot that acknowledged them
    mapping(uint64 => Order) internal _orders;

    event AccountSet(address account);
    event HedgeAccountSet(address hedgeAccount);
    event RelayerSet(address relayer);
    event MaxStateAgeSet(uint32 age);
    event OrderRequested(
        uint64 indexed nonce,
        uint32 asset,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        bool reduceOnly,
        uint8 tif,
        uint128 cloid
    );
    event SnapshotPosted(
        address indexed source, uint64 observedAt, int64 szi, int64 accountValue, uint64 oraclePx, uint64 executedNonce
    );
    event SnapshotIgnored(address indexed source, uint64 observedAt, uint64 latest);
    event OrdersAcknowledged(uint64 executedNonce, uint64 observedAt);

    error NotAccount();
    error NotRelayer();
    error AccountAlreadySet();
    error ZeroAddress();
    error StaleState(uint64 observedAt);
    error ReportFromFuture(uint64 observedAt);
    error BadAck(uint64 executedNonce, uint64 actionCount);
    error UnknownAsset(uint32 index);

    /// @param forwarder_ the Chainlink forwarder allowed to deliver CRE snapshots (`ReceiverTemplate`)
    constructor(address owner_, address forwarder_, address relayer_, uint32 perpIndex_, uint32 perpDexIndex_)
        ReceiverTemplate(forwarder_)
    {
        _transferOwnership(owner_);
        perpIndex = perpIndex_;
        perpDexIndex = perpDexIndex_;
        relayer = relayer_;
        emit RelayerSet(relayer_);
    }

    // ═══ admin ═════════════════════════════════════════════════════════════

    /// @notice Bind the gateway to its vault, once (the vault takes the gateway in its constructor).
    function setAccount(address account_) external onlyOwner {
        if (account != address(0)) revert AccountAlreadySet();
        if (account_ == address(0)) revert ZeroAddress();
        account = account_;
        emit AccountSet(account_);
    }

    function setHedgeAccount(address hedgeAccount_) external onlyOwner {
        hedgeAccount = hedgeAccount_;
        emit HedgeAccountSet(hedgeAccount_);
    }

    /// @notice address(0) leaves the CRE workflow as the only source of snapshots (orders are then never acknowledged).
    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerSet(relayer_);
    }

    function setMaxStateAge(uint32 age) external onlyOwner {
        maxStateAge = age;
        emit MaxStateAgeSet(age);
    }

    // ═══ writes (the vault's CoreWriter) ═══════════════════════════════════

    /// @notice CoreWriter's limit order, for the relayer to place on HyperCore.
    function placeOrder(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint128 cloid)
        external
        returns (uint64 nonce)
    {
        if (msg.sender != account) revert NotAccount();
        nonce = ++actionCount;
        _orders[nonce] = Order(asset, isBuy, limitPx, sz, reduceOnly, TIF_IOC, cloid, uint64(block.timestamp));
        emit OrderRequested(nonce, asset, isBuy, limitPx, sz, reduceOnly, TIF_IOC, cloid);
    }

    // ═══ snapshots ═════════════════════════════════════════════════════════

    /// @notice The relayer's snapshot, taken after it sent every order up to `s.executedNonce`.
    function relay(Snapshot calldata s) external {
        if (msg.sender != relayer) revert NotRelayer();
        _post(s, true);
    }

    /// @dev The CRE workflow's snapshot. It can't vouch for orders, so its `executedNonce` is ignored.
    function _processReport(bytes calldata report) internal override {
        _post(abi.decode(report, (Snapshot)), false);
    }

    /// @dev The newest observation wins; an older one is ignored rather than reverting, so the two sources can't fail
    ///      each other's transactions. An acknowledgement always counts: the relayer took its snapshot after sending
    ///      the orders, and any newer snapshot was taken later still.
    function _post(Snapshot memory s, bool fromRelayer) internal {
        if (s.observedAt > block.timestamp + MAX_CLOCK_SKEW) revert ReportFromFuture(s.observedAt);
        if (fromRelayer && s.executedNonce > executedNonce) {
            if (s.executedNonce > actionCount) revert BadAck(s.executedNonce, actionCount);
            executedNonce = s.executedNonce;
            executedAt = s.observedAt;
            emit OrdersAcknowledged(s.executedNonce, s.observedAt);
        }

        uint64 latest = _last.observedAt;
        if (s.observedAt <= latest) {
            emit SnapshotIgnored(msg.sender, s.observedAt, latest);
            return;
        }
        s.executedNonce = executedNonce;
        _last = s;
        emit SnapshotPosted(msg.sender, s.observedAt, s.szi, s.accountValue, s.oraclePx, s.executedNonce);
    }

    // ═══ reads (the vault's precompiles) ═══════════════════════════════════

    /// @notice Every order acknowledged: the last snapshot was taken after HyperCore saw each one.
    function settled() public view returns (bool) {
        return executedNonce == actionCount && _last.observedAt >= executedAt;
    }

    /// @notice True while the last snapshot is within `maxStateAge`.
    function fresh() public view returns (bool) {
        uint64 at = _last.observedAt;
        return at != 0 && block.timestamp <= uint256(at) + maxStateAge;
    }

    function lastSnapshot() external view returns (Snapshot memory) {
        return _last;
    }

    function orders(uint64 nonce) external view returns (Order memory) {
        return _orders[nonce];
    }

    /// @notice position2 precompile.
    function position(address user, uint32 index) external view returns (PrecompileLib.Position memory p) {
        Snapshot memory s = _read(index);
        if (user != account) return p;
        p = PrecompileLib.Position({
            szi: s.szi, entryNtl: s.entryNtl, isolatedRawUsd: 0, leverage: s.leverage, isIsolated: true
        });
    }

    /// @notice oraclePx precompile; 0 means unknown, as there.
    function oraclePx(uint32 index) external view returns (uint64) {
        return _read(index).oraclePx;
    }

    /// @notice markPx precompile.
    function markPx(uint32 index) external view returns (uint64) {
        return _read(index).markPx;
    }

    /// @notice accountMarginSummary precompile, for the vault's perp DEX.
    function accountMarginSummary(uint32 dex, address user)
        external
        view
        returns (PrecompileLib.AccountMarginSummary memory m)
    {
        Snapshot memory s = _read(perpIndex);
        if (user != account || dex != perpDexIndex) return m;
        m = PrecompileLib.AccountMarginSummary({
            accountValue: s.accountValue,
            marginUsed: s.marginUsed,
            ntlPos: s.ntlPos,
            rawUsd: s.szi < 0 ? s.accountValue + int64(s.ntlPos) : s.accountValue - int64(s.ntlPos)
        });
    }

    /// @notice spotBalance precompile (USDC only).
    function spotBalance(address user, uint64 token) external view returns (PrecompileLib.SpotBalance memory b) {
        Snapshot memory s = _read(perpIndex);
        if (user == account && token == 0) b.total = s.spotUsdcWei;
    }

    /// @notice coreUserExists precompile: the hedge account as last seen, however old (an account never disappears).
    function coreUserExists(address user) external view returns (bool) {
        return user == account && _last.exists;
    }

    function _read(uint32 index) internal view returns (Snapshot memory s) {
        if (index != perpIndex) revert UnknownAsset(index);
        s = _last;
        if (s.observedAt == 0 || block.timestamp > uint256(s.observedAt) + maxStateAge) revert StaleState(s.observedAt);
    }
}
