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
        uint16 maxSlippageBps; // unwind minAmountOut vs Core oracle value (pool fee + impact + basis)
        uint8 maxTries; // syncHedge retries before pausing
        uint32 orderDelaySec; // wait after sendRawAction before syncHedge
        uint32 cooldownOpenSec; // unwind cooldown while stock market is open
        uint32 cooldownClosedSec; // unwind cooldown while closed
        uint256 withdrawReserve; // idle USDC kept back for margin top-ups while the vault has exposure
        uint16 maxImpactBps; // max pool price move per unwind chunk, enforced as the swap's price limit
        uint8 transitBlocks; // blocks a HyperEVM → HyperCore deposit is counted as in transit (VERIFY: 1)
    }

    uint256 internal constant BPS = 10_000;

    Params internal _p;
    bool public marketOpen; // demo flag; prod would read oracle market-status

    event ParamsSet(Params p);
    event MarketOpenSet(bool open);

    error InvalidParams();

    constructor(address owner_, Params memory p) Ownable(owner_) {
        _set(p);
    }

    function get() external view returns (Params memory) {
        return _p;
    }

    function setParams(Params calldata p) external onlyOwner {
        _set(p);
    }

    function setMarketOpen(bool open) external onlyOwner {
        marketOpen = open;
        emit MarketOpenSet(open);
    }

    function cooldown() external view returns (uint32) {
        return marketOpen ? _p.cooldownOpenSec : _p.cooldownClosedSec;
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
