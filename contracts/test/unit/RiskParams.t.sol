// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";

contract RiskParamsTest is Test {
    address owner = makeAddr("owner");
    RiskParams risk;

    function setUp() public {
        risk = new RiskParams(owner, DeployHelpers.defaultRisk());
    }

    function test_get_returnsWhatWasSet() public view {
        RiskParams.Params memory p = risk.get();
        assertEq(p.maxUnhedged, 2000);
        assertEq(p.maxTries, 3);
        assertEq(p.transitBlocks, 1);
    }

    function test_setParams_onlyOwner() public {
        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        risk.setParams(p);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        risk.setMarketOpen(true);
    }

    function test_setParams_rejectsNonsense() public {
        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        p.leverage = 0;
        _expectInvalid(p);

        p = DeployHelpers.defaultRisk();
        p.maxTries = 0;
        _expectInvalid(p);

        p = DeployHelpers.defaultRisk();
        p.maxUnhedged = 0;
        _expectInvalid(p);

        p = DeployHelpers.defaultRisk();
        p.hedgeCapBps = 10_000;
        _expectInvalid(p);

        p = DeployHelpers.defaultRisk();
        p.maxImpactBps = 0;
        _expectInvalid(p);

        p = DeployHelpers.defaultRisk();
        p.transitBlocks = 0;
        _expectInvalid(p);
    }

    function test_cooldown_followsMarketHours() public {
        assertEq(risk.cooldown(), 300);
        vm.prank(owner);
        risk.setMarketOpen(true);
        assertEq(risk.cooldown(), 10);
    }

    function _expectInvalid(RiskParams.Params memory p) internal {
        vm.prank(owner);
        vm.expectRevert(RiskParams.InvalidParams.selector);
        risk.setParams(p);
    }
}
