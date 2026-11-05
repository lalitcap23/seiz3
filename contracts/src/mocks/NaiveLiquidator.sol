// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IMorphoLiquidateCallback} from "@morpho-blue/interfaces/IMorphoCallbacks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {UnwindLib} from "../libs/UnwindLib.sol";

/// @notice Market A in the demo: liquidates, dumps seized collateral into the thin v4 pool,
///         tops up the shortfall from its own balance and reports it as bad debt.
/// @dev Pre-fund it with enough USDC to cover a full repayment. Any NVDAx the thin pool can't absorb
///      stays here; nothing is hedged, which is the point of the comparison.
contract NaiveLiquidator is IMorphoLiquidateCallback, IUnlockCallback, Ownable {
    using SafeERC20 for IERC20;

    IMorpho public immutable morpho;
    IPoolManager public immutable poolManager;
    IERC20 public immutable usdc;
    IERC20 public immutable nvdax;
    bool public immutable nvdaxIsCurrency0;
    PoolKey public poolKey;

    /// @notice Running total the dashboard shows as "bad debt the lenders would have eaten".
    uint256 public totalShortfall;

    event Shortfall(address indexed borrower, uint256 repaid, uint256 proceeds, uint256 shortfall);

    error WrongMarket();
    error NotMorpho();
    error NotPoolManager();

    constructor(address owner_, IMorpho morpho_, IPoolManager poolManager_, PoolKey memory key, IERC20 nvdax_)
        Ownable(owner_)
    {
        morpho = morpho_;
        poolManager = poolManager_;
        poolKey = key;
        nvdax = nvdax_;
        nvdaxIsCurrency0 = Currency.unwrap(key.currency0) == address(nvdax_);
        usdc = IERC20(Currency.unwrap(nvdaxIsCurrency0 ? key.currency1 : key.currency0));
    }

    function liquidate(MarketParams calldata params, address borrower, uint256 seized)
        external
        onlyOwner
        returns (uint256 repaid)
    {
        if (params.collateralToken != address(nvdax) || params.loanToken != address(usdc)) {
            revert WrongMarket();
        }
        (, repaid) = morpho.liquidate(params, borrower, seized, 0, abi.encode(borrower, seized));
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        (address borrower, uint256 seized) = abi.decode(data, (address, uint256));

        // dump everything at whatever the pool pays
        (, uint256 proceeds) = abi.decode(poolManager.unlock(abi.encode(seized)), (uint256, uint256));

        uint256 shortfall = repaidAssets > proceeds ? repaidAssets - proceeds : 0;
        totalShortfall += shortfall;
        emit Shortfall(borrower, repaidAssets, proceeds, shortfall);

        usdc.forceApprove(address(morpho), repaidAssets); // the shortfall comes out of our own balance
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amountIn = abi.decode(data, (uint256));
        (uint256 sold, uint256 out) =
            UnwindLib.swapExactIn(poolManager, poolKey, nvdaxIsCurrency0, amountIn, UnwindLib.noLimit(nvdaxIsCurrency0));
        return abi.encode(sold, out);
    }

    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
