// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {RiskParams} from "../src/RiskParams.sol";

library DeployHelpers {
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    /// @dev Testnet's separate "weekend" pool for market A's NaiveLiquidator, so the vault's pool can stay deep.
    uint24 internal constant THIN_POOL_FEE = 500;
    int24 internal constant THIN_TICK_SPACING = 10;

    /// @notice Hackathon defaults for xyz:NVDA (szDecimals 3, ~$217, max 20x). Tune after the pre-kickoff
    ///         spikes (orderDelaySec and transitBlocks especially).
    function defaultRisk() internal pure returns (RiskParams.Params memory) {
        return RiskParams.Params({
            maxLiquidation: 50_000e6,
            maxUnhedged: 2000, // Core size units; at szDecimals=3 → 2 NVDA (~$430), also the unwind chunk
            leverage: 3,
            marginBufferBps: 2000,
            minDiscountBps: 300,
            oracleBandBps: 150,
            hedgeCapBps: 100,
            maxSlippageBps: 100, // pool fee 30 + impact ≤ 50 + basis
            maxTries: 3,
            orderDelaySec: 5,
            cooldownOpenSec: 10,
            cooldownClosedSec: 300,
            withdrawReserve: 500e6,
            maxImpactBps: 50,
            transitBlocks: 1
        });
    }

    /// @notice The NVDAx/USDC pool every script and the vault agree on: 0.3% fee, no hooks.
    function poolKey(address usdc, address nvdax) internal pure returns (PoolKey memory) {
        (address c0, address c1) = usdc < nvdax ? (usdc, nvdax) : (nvdax, usdc);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), POOL_FEE, TICK_SPACING, IHooks(address(0)));
    }

    /// @notice Same tokens on the 0.05% tier: a different pool id. Only testnet has it (TestnetExtras.s.sol).
    function thinPoolKey(address usdc, address nvdax) internal pure returns (PoolKey memory key) {
        key = poolKey(usdc, nvdax);
        key.fee = THIN_POOL_FEE;
        key.tickSpacing = THIN_TICK_SPACING;
    }

    function deploymentPath(string memory projectRoot, string memory network) internal pure returns (string memory) {
        return string.concat(projectRoot, "/../deployments/", network, ".json");
    }
}
