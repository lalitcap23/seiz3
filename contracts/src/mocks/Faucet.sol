// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet faucet for demo testers: a little NVDAx (collateral), USDC (LP deposits, swaps) and HYPE (gas),
///         once per address per `cooldown`. It hands out what it holds, so the owner refills it and its balance caps
///         what testers can take in total.
/// @dev A new tester has no HYPE to call `claim`, so the API's operator key calls `drip(to)` for them (and rate-limits
///      by IP off-chain). HYPE is only topped up to `nativeDrip`, never stacked.
contract Faucet is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable nvdax;
    IERC20 public immutable usdc;

    uint256 public nvdaxDrip;
    uint256 public usdcDrip;
    uint256 public nativeDrip;
    uint64 public cooldown;
    mapping(address => bool) public operators;
    mapping(address => uint64) public lastDrip;

    event Dripped(address indexed to, uint256 nvdax, uint256 usdc, uint256 native);
    event DripsSet(uint256 nvdax, uint256 usdc, uint256 native, uint64 cooldown);
    event OperatorSet(address indexed operator, bool allowed);

    error NotOperator();
    error TooSoon(uint64 nextAt);
    error NativeSendFailed();

    constructor(
        address owner_,
        IERC20 nvdax_,
        IERC20 usdc_,
        uint256 nvdaxDrip_,
        uint256 usdcDrip_,
        uint256 nativeDrip_,
        uint64 cooldown_
    ) Ownable(owner_) {
        nvdax = nvdax_;
        usdc = usdc_;
        _setDrips(nvdaxDrip_, usdcDrip_, nativeDrip_, cooldown_);
    }

    receive() external payable {}

    function claim() external {
        _drip(msg.sender);
    }

    function drip(address to) external {
        if (!operators[msg.sender] && msg.sender != owner()) revert NotOperator();
        _drip(to);
    }

    /// @notice When `to` may next receive a drip (0: now).
    function nextDripAt(address to) public view returns (uint64) {
        uint64 last = lastDrip[to];
        return last == 0 ? 0 : last + cooldown;
    }

    function setDrips(uint256 nvdax_, uint256 usdc_, uint256 native_, uint64 cooldown_) external onlyOwner {
        _setDrips(nvdax_, usdc_, native_, cooldown_);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Take funds back; `token` 0 is HYPE.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _drip(address to) internal {
        uint64 next = nextDripAt(to);
        if (block.timestamp < next) revert TooSoon(next);
        lastDrip[to] = uint64(block.timestamp);

        uint256 n = _min(nvdaxDrip, nvdax.balanceOf(address(this)));
        uint256 u = _min(usdcDrip, usdc.balanceOf(address(this)));
        uint256 h = to.balance < nativeDrip ? _min(nativeDrip - to.balance, address(this).balance) : 0;
        if (n != 0) nvdax.safeTransfer(to, n);
        if (u != 0) usdc.safeTransfer(to, u);
        if (h != 0) _sendNative(to, h);
        emit Dripped(to, n, u, h);
    }

    function _setDrips(uint256 nvdax_, uint256 usdc_, uint256 native_, uint64 cooldown_) internal {
        nvdaxDrip = nvdax_;
        usdcDrip = usdc_;
        nativeDrip = native_;
        cooldown = cooldown_;
        emit DripsSet(nvdax_, usdc_, native_, cooldown_);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeSendFailed();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
