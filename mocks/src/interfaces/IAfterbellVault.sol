// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IAfterbellVaultMock {
    struct Pending {
        int64 delta;
        uint64 sentBlock;
        uint64 sentAt;
        uint8 tries;
    }

    struct Risk {
        uint256 maxLiquidation;
        uint32 hedgeLeverage;
        uint32 marginBufferBps;
        uint32 maxUnhedgedBps;
        uint32 maxSlippageBps;
        uint32 oracleBandBps;
        uint8 maxTries;
        uint32 orderDelaySec;
        uint32 unwindCooldownSec;
    }

    event LiquidationTaken(bytes32 indexed marketId, address indexed borrower, uint256 seized, uint256 repaid);
    event HedgeSent(int64 delta, uint8 tries);
    event HedgeConfirmed(int64 actual, int64 target);
    event HedgeStuck(int64 gap);
    event Unwound(uint256 chunk, uint256 usdcOut);
    event MarginMoved(int256 amount);
}
