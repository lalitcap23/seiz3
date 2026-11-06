// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @notice Owner-only liquidity for the demo NVDAx/USDC pool: thin "weekend" seeding, deep "Monday" top-up,
///         and the Monday arbitrage that brings a dumped pool back to the oracle.
/// @dev v4-core's PoolModifyLiquidityTest is public, so anyone could pull liquidity it holds; this one only
///      moves tokens to and from its owner. Positions are owned by this contract.
contract PoolSeeder is IUnlockCallback, Ownable {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    error NotPoolManager();

    constructor(address owner_, IPoolManager poolManager_) Ownable(owner_) {
        poolManager = poolManager_;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner returns (int24 tick) {
        return poolManager.initialize(key, sqrtPriceX96);
    }

    /// @notice Add (positive delta) or remove (negative) liquidity. Tokens are pulled from / paid to the owner,
    ///         who must approve this contract first.
    function modifyLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        bytes32 salt
    ) external onlyOwner returns (BalanceDelta delta) {
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
            tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: salt
        });
        delta = abi.decode(poolManager.unlock(abi.encode(false, abi.encode(key, params))), (BalanceDelta));
    }

    /// @notice Move the pool price to `sqrtPriceX96` with one swap, paid by the owner (who must approve this
    ///         contract first). After a dump into a thin pool the ticks back to the oracle hold no liquidity,
    ///         so the swap costs next to nothing.
    function swapToPrice(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner returns (BalanceDelta delta) {
        (uint160 current,,,) = poolManager.getSlot0(key.toId());
        if (current == sqrtPriceX96) return delta;
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: sqrtPriceX96 < current,
            amountSpecified: type(int128).min, // exact input; the price limit stops it long before
            sqrtPriceLimitX96: sqrtPriceX96
        });
        delta = abi.decode(poolManager.unlock(abi.encode(true, abi.encode(key, params))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool isSwap, bytes memory inner) = abi.decode(data, (bool, bytes));
        PoolKey memory key;
        BalanceDelta delta;
        if (isSwap) {
            IPoolManager.SwapParams memory params;
            (key, params) = abi.decode(inner, (PoolKey, IPoolManager.SwapParams));
            delta = poolManager.swap(key, params, "");
        } else {
            IPoolManager.ModifyLiquidityParams memory params;
            (key, params) = abi.decode(inner, (PoolKey, IPoolManager.ModifyLiquidityParams));
            (delta,) = poolManager.modifyLiquidity(key, params, "");
        }
        _settleOrTake(key.currency0, delta.amount0());
        _settleOrTake(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settleOrTake(Currency currency, int128 amount) internal {
        if (amount < 0) {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(owner(), address(poolManager), uint128(-amount));
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, owner(), uint128(amount));
        }
    }
}
