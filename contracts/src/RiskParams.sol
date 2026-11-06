// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";

/// @notice Owner-set caps read by the vault. One struct so the vault can load it in a single call.
///         Also the consumer of the Chainlink CRE workflow (packages/cre), which reports the two facts the vault
///         can't read on-chain: whether the US stock market is open (Data Streams `marketStatus`) and how much
///         NVDA HyperCore's xyz book can absorb (`hedgeCapacity`, from Hyperliquid's l2Book).
/// @dev The report takes over from the owner's values once the first one lands. While it is fresh, `get()` lowers
///      `maxLiquidation` to the hedge capacity and `marketOpen()` is the reported status; the vault and hook already
///      read both, so they need no change. A report older than `maxReportAge` fails closed: no liquidations, and
///      after-hours pricing. `maxReportAge = 0` turns the feed off and the owner's values apply again.
contract RiskParams is ReceiverTemplate {
    struct Params {
        uint256 maxLiquidation; // max seized notional per liquidation, USDC 6 dec
        uint64 maxUnhedged; // max |inventory + short|, Core size units; also caps unwind chunk
        uint16 leverage; // perp leverage used for margin pre-check
        uint16 marginBufferBps; // extra margin over notional / leverage
        uint16 minDiscountBps; // discount floor checked in onMorphoLiquidate
        uint16 oracleBandBps; // max gap lending oracle / pool vs Core oraclePx
        uint16 hedgeCapBps; // IOC limit price offset from oraclePx (100 = 1%)
        uint16 maxSlippageBps; // unwind minAmountOut vs Core oracle value (pool fee + impact + basis)
        uint8 maxTries; // syncHedge retries before pausing
        uint32 orderDelaySec; // wait after sendRawAction before syncHedge
        uint32 cooldownOpenSec; // unwind cooldown while stock market is open
        uint32 cooldownClosedSec; // unwind cooldown while closed
        uint256 withdrawReserve; // idle USDC kept back for margin top-ups while the vault has exposure
        uint16 maxImpactBps; // max pool price move per unwind chunk, enforced as the swap's price limit
        uint8 transitBlocks; // blocks a HyperEVM → HyperCore deposit is counted as in transit (VERIFY: 1)
    }

    /// @notice The last CRE report. Layout on the wire: abi.encode(bool open, uint256 hedgeCapacity, uint64 observedAt).
    struct MarketReport {
        bool open; // Data Streams marketStatus is Open (regular hours)
        uint64 observedAt; // unix seconds: the older of the market-status and order-book observations
        uint128 hedgeCapacity; // USDC 6 dec: xyz:NVDA bids within hedgeCapBps of the Core oracle, valued at the oracle
    }

    uint256 internal constant BPS = 10_000;
    /// @dev How far ahead of the block a report's observation may be (node clocks vs block time).
    uint256 internal constant MAX_CLOCK_SKEW = 60;

    Params internal _p;
    MarketReport public lastReport;
    uint32 public maxReportAge = 300; // five one-minute cron runs
    bool internal _ownerMarketOpen; // demo flag, until the first CRE report

    event ParamsSet(Params p);
    event MarketOpenSet(bool open);
    event MarketReported(bool open, uint256 hedgeCapacity, uint64 observedAt);
    event MaxReportAgeSet(uint32 age);

    error InvalidParams();
    error ReportOutOfOrder();
    error ReportFromFuture();

    /// @param forwarder_ the Chainlink forwarder allowed to deliver reports (`ReceiverTemplate`)
    constructor(address owner_, address forwarder_, Params memory p) ReceiverTemplate(forwarder_) {
        _transferOwnership(owner_);
        _set(p);
    }

    /// @notice The caps the vault enforces: the owner's, with `maxLiquidation` lowered to the CRE hedge capacity.
    function get() external view returns (Params memory p) {
        p = _p;
        (bool live, bool fresh, MarketReport memory r) = _report();
        if (live) {
            uint256 cap = fresh ? r.hedgeCapacity : 0;
            if (cap < p.maxLiquidation) p.maxLiquidation = cap;
        }
    }

    /// @notice The owner's caps as set, before the CRE hedge capacity.
    function params() external view returns (Params memory) {
        return _p;
    }

    /// @notice Is the US stock market open: the CRE report while the feed is on, else the owner's flag.
    function marketOpen() public view returns (bool) {
        (bool live, bool fresh, MarketReport memory r) = _report();
        return live ? fresh && r.open : _ownerMarketOpen;
    }

    function setParams(Params calldata p) external onlyOwner {
        _set(p);
    }

    function setMarketOpen(bool open) external onlyOwner {
        _ownerMarketOpen = open;
        emit MarketOpenSet(open);
    }

    function setMaxReportAge(uint32 age) external onlyOwner {
        maxReportAge = age;
        emit MaxReportAgeSet(age);
    }

    function cooldown() external view returns (uint32) {
        return marketOpen() ? _p.cooldownOpenSec : _p.cooldownClosedSec;
    }

    /// @dev Reports arrive in observation order; a replayed or delayed one is rejected rather than rolling state back.
    function _processReport(bytes calldata data) internal override {
        (bool open, uint256 capacity, uint64 observedAt) = abi.decode(data, (bool, uint256, uint64));
        if (observedAt <= lastReport.observedAt) revert ReportOutOfOrder();
        if (observedAt > block.timestamp + MAX_CLOCK_SKEW) revert ReportFromFuture();
        uint128 cap = capacity > type(uint128).max ? type(uint128).max : uint128(capacity);
        lastReport = MarketReport(open, observedAt, cap);
        emit MarketReported(open, capacity, observedAt);
    }

    /// @dev live: the feed is on and has reported. fresh: the last report is within `maxReportAge`.
    function _report() internal view returns (bool live, bool fresh, MarketReport memory r) {
        r = lastReport;
        uint256 age = maxReportAge;
        live = age != 0 && r.observedAt != 0;
        fresh = live && block.timestamp <= uint256(r.observedAt) + age;
    }

    function _set(Params memory p) internal {
        if (
            p.leverage == 0 || p.maxTries == 0 || p.transitBlocks == 0 || p.maxUnhedged == 0
                || p.maxUnhedged > uint64(type(int64).max) || p.minDiscountBps >= BPS || p.oracleBandBps >= BPS
                || p.hedgeCapBps >= BPS || p.maxSlippageBps >= BPS || p.maxImpactBps == 0 || p.maxImpactBps >= BPS
        ) revert InvalidParams();
        _p = p;
        emit ParamsSet(p);
    }
}
