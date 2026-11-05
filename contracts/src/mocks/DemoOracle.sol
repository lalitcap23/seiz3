// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracle} from "@morpho-blue/interfaces/IOracle.sol";

/// @notice Morpho-format oracle the replay can move. Deploy one per demo market so the market ids differ.
/// @dev price = (USDC per 1 NVDAx) * 10^(36 + loanDecimals - collateralDecimals) = usd * 1e24 for 6/18 dec.
contract DemoOracle is IOracle, Ownable {
    uint256 public price;

    event PriceSet(uint256 price);

    constructor(address owner_, uint256 initialPrice) Ownable(owner_) {
        price = initialPrice;
        emit PriceSet(initialPrice);
    }

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceSet(newPrice);
    }
}
