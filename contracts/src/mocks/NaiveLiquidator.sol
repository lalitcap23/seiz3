// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IMorphoLiquidateCallback} from "@morpho-blue/interfaces/IMorphoCallbacks.sol";

/// @notice Market A in the demo: liquidates, dumps seized collateral into the thin v4 pool,
///         tops up the shortfall from its own balance and reports it as bad debt.
contract NaiveLiquidator is IMorphoLiquidateCallback {
    IMorpho public immutable morpho;

    event Shortfall(address indexed borrower, uint256 repaid, uint256 proceeds, uint256 shortfall);

    constructor(IMorpho morpho_) {
        morpho = morpho_;
    }

    function liquidate(MarketParams calldata params, address borrower, uint256 seized) external {
        // TODO: morpho.liquidate(params, borrower, seized, 0, abi.encode(params, borrower));
        params;
        borrower;
        seized;
        revert("TODO");
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        // TODO: swap seized NVDAx in the thin pool, top up shortfall, approve morpho, emit Shortfall
        repaidAssets;
        data;
        revert("TODO");
    }
}
