// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Faucet} from "../../src/mocks/Faucet.sol";
import {MockNVDAx} from "../../src/mocks/MockNVDAx.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

contract FaucetTest is Test {
    uint256 constant NVDAX_DRIP = 0.1e18;
    uint256 constant USDC_DRIP = 20e6;
    uint256 constant NATIVE_DRIP = 0.002 ether;
    uint64 constant COOLDOWN = 1 days;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address tester = makeAddr("tester");

    MockNVDAx nvdax;
    MockUSDC usdc;
    Faucet faucet;

    function setUp() public {
        vm.warp(1_760_000_000);
        nvdax = new MockNVDAx(owner);
        usdc = new MockUSDC();
        faucet = new Faucet(
            owner, IERC20(address(nvdax)), IERC20(address(usdc)), NVDAX_DRIP, USDC_DRIP, NATIVE_DRIP, COOLDOWN
        );
        vm.prank(owner);
        nvdax.mint(address(faucet), 1e18);
        usdc.mint(address(faucet), 100e6);
        vm.deal(address(faucet), 0.01 ether);
        vm.prank(owner);
        faucet.setOperator(operator, true);
    }

    function test_operatorDripsAllThree() public {
        vm.prank(operator);
        faucet.drip(tester);
        assertEq(nvdax.balanceOf(tester), NVDAX_DRIP);
        assertEq(usdc.balanceOf(tester), USDC_DRIP);
        assertEq(tester.balance, NATIVE_DRIP);
    }

    function test_oncePerCooldown() public {
        vm.prank(operator);
        faucet.drip(tester);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Faucet.TooSoon.selector, uint64(block.timestamp) + COOLDOWN));
        faucet.drip(tester);

        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(tester);
        faucet.claim();
        assertEq(nvdax.balanceOf(tester), 2 * NVDAX_DRIP);
    }

    function test_hypeOnlyToppedUp() public {
        vm.deal(tester, NATIVE_DRIP / 4);
        vm.prank(operator);
        faucet.drip(tester);
        assertEq(tester.balance, NATIVE_DRIP, "topped up to the drip, not stacked");

        address rich = makeAddr("rich");
        vm.deal(rich, 1 ether);
        vm.prank(operator);
        faucet.drip(rich);
        assertEq(rich.balance, 1 ether);
    }

    function test_paysWhatIsLeft() public {
        vm.prank(owner);
        faucet.setDrips(NVDAX_DRIP, 80e6, NATIVE_DRIP, COOLDOWN);
        vm.prank(operator);
        faucet.drip(tester);
        address second = makeAddr("second");
        vm.prank(operator);
        faucet.drip(second);
        assertEq(usdc.balanceOf(second), 20e6, "only 20 left");

        address third = makeAddr("third");
        vm.prank(operator);
        faucet.drip(third); // nothing left in USDC: still drips the rest
        assertEq(usdc.balanceOf(third), 0);
        assertEq(nvdax.balanceOf(third), NVDAX_DRIP);
    }

    function test_dripIsOperatorOnly() public {
        vm.prank(tester);
        vm.expectRevert(Faucet.NotOperator.selector);
        faucet.drip(makeAddr("other"));
    }

    function test_adminIsOwnerOnly() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        faucet.withdraw(address(0), operator, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        faucet.setDrips(1, 1, 1, 0);
        vm.stopPrank();
    }

    function test_ownerWithdraws() public {
        vm.startPrank(owner);
        faucet.withdraw(address(0), owner, 0.01 ether);
        faucet.withdraw(address(usdc), owner, 100e6);
        vm.stopPrank();
        assertEq(owner.balance, 0.01 ether);
        assertEq(usdc.balanceOf(owner), 100e6);
    }
}
