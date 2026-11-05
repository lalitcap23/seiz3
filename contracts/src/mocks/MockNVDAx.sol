// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Test stock token, 18 decimals, owner-mintable.
contract MockNVDAx is ERC20, Ownable {
    constructor(address owner_) ERC20("Mock NVIDIA xStock", "NVDAx") Ownable(owner_) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
