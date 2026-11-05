// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RiskParams} from "../src/RiskParams.sol";

library DeployHelpers {
    /// @notice Hackathon defaults. Tune after the pre-kickoff spikes (orderDelaySec especially).
    function defaultRisk() internal pure returns (RiskParams.Params memory) {
        return RiskParams.Params({
            maxLiquidation: 50_000e6,
            maxUnhedged: 50, // Core size units; at szDecimals=3 → 0.05 NVDA
            leverage: 3,
            marginBufferBps: 2000,
            minDiscountBps: 300,
            oracleBandBps: 150,
            hedgeCapBps: 100,
            maxSlippageBps: 50,
            maxTries: 3,
            orderDelaySec: 5,
            cooldownOpenSec: 30,
            cooldownClosedSec: 300,
            withdrawReserve: 500e6
        });
    }
}
