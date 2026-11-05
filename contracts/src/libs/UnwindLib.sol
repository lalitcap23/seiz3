// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Exact-in NVDAx → USDC swap on the v4 pool. Call ONLY from inside `unlockCallback`.
library UnwindLib {
    using SafeERC20 for IERC20;

    /// @return usdcOut amount of USDC taken from the PoolManager
    function swapExactIn(IPoolManager pm, PoolKey memory key, bool nvdaxIsCurrency0, uint256 amountIn)
        internal
        returns (uint256 usdcOut)
    {
        BalanceDelta d = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: nvdaxIsCurrency0,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: nvdaxIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        (Currency inC, Currency outC) =
            nvdaxIsCurrency0 ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 owed = nvdaxIsCurrency0 ? d.amount0() : d.amount1();
        int128 got = nvdaxIsCurrency0 ? d.amount1() : d.amount0();

        // settle what we owe (NVDAx)
        pm.sync(inC);
        IERC20(Currency.unwrap(inC)).safeTransfer(address(pm), uint256(uint128(-owed)));
        pm.settle();
        // take what we're owed (USDC)
        usdcOut = uint256(uint128(got));
        pm.take(outC, address(this), usdcOut);
    }
}
