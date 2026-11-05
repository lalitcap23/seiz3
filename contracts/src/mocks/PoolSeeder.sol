// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice Owner-only liquidity for the demo NVDAx/USDC pool: thin "weekend" seeding, deep "Monday" top-up.
/// @dev v4-core's PoolModifyLiquidityTest is public, so anyone could pull liquidity it holds; this one only
///      moves tokens to and from its owner. Positions are owned by this contract.
contract PoolSeeder is IUnlockCallback, Ownable {
    using SafeERC20 for IERC20;

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
        delta = abi.decode(poolManager.unlock(abi.encode(key, params)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, IPoolManager.ModifyLiquidityParams memory params) =
            abi.decode(data, (PoolKey, IPoolManager.ModifyLiquidityParams));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key, params, "");
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
