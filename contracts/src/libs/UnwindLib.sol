// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice NVDAx → USDC swaps on the v4 pool plus the price maths around them.
///         `swapExactIn` may only be called from inside `unlockCallback`.
/// @dev The swap and pool reads are `external`, so this deploys as a linked library (delegatecall keeps the
///      caller's context). That keeps AfterbellVault under the 24 KB code-size limit.
library UnwindLib {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant Q192 = 1 << 192;

    /// @notice Exact-in sell of up to `amountIn` NVDAx, stopping early at `sqrtPriceLimitX96`.
    /// @return sold    NVDAx actually paid to the pool (≤ amountIn when the limit is hit)
    /// @return usdcOut USDC taken from the PoolManager
    function swapExactIn(
        IPoolManager pm,
        PoolKey memory key,
        bool nvdaxIsCurrency0,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 sold, uint256 usdcOut) {
        BalanceDelta d = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: nvdaxIsCurrency0, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            ""
        );

        (Currency inC, Currency outC) =
            nvdaxIsCurrency0 ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 owed = nvdaxIsCurrency0 ? d.amount0() : d.amount1();
        int128 got = nvdaxIsCurrency0 ? d.amount1() : d.amount0();

        // settle what we owe (NVDAx)
        if (owed < 0) {
            sold = uint256(uint128(-owed));
            pm.sync(inC);
            IERC20(Currency.unwrap(inC)).safeTransfer(address(pm), sold);
            pm.settle();
        }
        // take what we're owed (USDC)
        if (got > 0) {
            usdcOut = uint256(uint128(got));
            pm.take(outC, address(this), usdcOut);
        }
    }

    /// @notice Current pool price.
    /// @return sqrtPriceX96 slot0 price
    /// @return usdcPerNvdax USDC (6 dec) per 1 whole NVDAx
    function poolPrice(IPoolManager pm, PoolKey memory key, bool nvdaxIsCurrency0)
        external
        view
        returns (uint160 sqrtPriceX96, uint256 usdcPerNvdax)
    {
        (sqrtPriceX96,,,) = pm.getSlot0(key.toId());
        usdcPerNvdax = usdcPerNvdaxAt(sqrtPriceX96, nvdaxIsCurrency0);
    }

    /// @notice sqrtPriceX96 → USDC (6 dec) per 1 whole NVDAx. P = currency1 units per currency0 unit.
    function usdcPerNvdaxAt(uint160 sqrtPriceX96, bool nvdaxIsCurrency0) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) return 0;
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64); // P × 2^128
        return nvdaxIsCurrency0
            ? Math.mulDiv(priceX128, 1e18, 1 << 128)  // USDC units per NVDAx unit × 1e18
            : Math.mulDiv(1e18, 1 << 128, priceX128); // P is NVDAx per USDC, so invert
    }

    /// @notice USDC (6 dec) per 1 whole NVDAx → sqrtPriceX96. Used to initialise the pool at the oracle price.
    function sqrtPriceAt(uint256 usdcPerNvdax, bool nvdaxIsCurrency0) internal pure returns (uint160) {
        uint256 priceX192 =
            nvdaxIsCurrency0 ? Math.mulDiv(usdcPerNvdax, Q192, 1e18) : Math.mulDiv(1e18, Q192, usdcPerNvdax);
        return uint160(Math.sqrt(priceX192));
    }

    /// @notice Price limit that caps one sell's impact at `maxImpactBps` off the NVDAx price.
    /// @dev Selling NVDAx pushes its USDC price down by a factor (1 − b), so sqrtP moves by √(1 − b):
    ///      down when NVDAx is currency0 (zeroForOne), up by the inverse when it is currency1.
    function impactLimit(uint160 sqrtPriceX96, uint16 maxImpactBps, bool nvdaxIsCurrency0)
        external
        pure
        returns (uint160)
    {
        uint256 factorX96 = Math.sqrt(Math.mulDiv(BPS - maxImpactBps, Q192, BPS)); // √(1 − b) × 2^96
        uint256 limit =
            nvdaxIsCurrency0 ? Math.mulDiv(sqrtPriceX96, factorX96, Q96) : Math.mulDiv(sqrtPriceX96, Q96, factorX96);
        if (limit <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        if (limit >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(limit);
    }

    /// @notice No price limit: take whatever the pool pays (used by the demo's naive liquidator).
    function noLimit(bool nvdaxIsCurrency0) internal pure returns (uint160) {
        return nvdaxIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }
}
