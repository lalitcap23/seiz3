// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Owner-set caps read by the vault. One struct so the vault can load it in a single call.
contract RiskParams is Ownable {
    struct Params {
        uint256 maxLiquidation; // max seized notional per liquidation, USDC 6 dec
        uint64 maxUnhedged; // max |inventory + short|, Core size units; also caps unwind chunk
        uint16 leverage; // perp leverage used for margin pre-check
        uint16 marginBufferBps; // extra margin over notional / leverage
        uint16 minDiscountBps; // discount floor checked in onMorphoLiquidate
        uint16 oracleBandBps; // max gap lending oracle / pool vs Core oraclePx
        uint16 hedgeCapBps; // IOC limit price offset from oraclePx (100 = 1%)
        uint16 maxSlippageBps; // unwind minAmountOut
        uint8 maxTries; // syncHedge retries before pausing
        uint32 orderDelaySec; // wait after sendRawAction before syncHedge
        uint32 cooldownOpenSec; // unwind cooldown while stock market is open
        uint32 cooldownClosedSec; // unwind cooldown while closed
        uint256 withdrawReserve; // idle USDC kept back for margin top-ups
    }

    Params internal _p;
    bool public marketOpen; // demo flag; prod would read oracle market-status

    event ParamsSet(Params p);
    event MarketOpenSet(bool open);

    constructor(address owner_, Params memory p) Ownable(owner_) {
        _p = p;
        emit ParamsSet(p);
    }

    function get() external view returns (Params memory) {
        return _p;
    }

    function setParams(Params calldata p) external onlyOwner {
        _p = p;
        emit ParamsSet(p);
    }

    function setMarketOpen(bool open) external onlyOwner {
        marketOpen = open;
        emit MarketOpenSet(open);
    }

    function cooldown() external view returns (uint32) {
        return marketOpen ? _p.cooldownOpenSec : _p.cooldownClosedSec;
    }
}
