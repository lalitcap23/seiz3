// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {ReceiverTemplate} from "../../src/cre/ReceiverTemplate.sol";
import {DeployHelpers} from "../../script/DeployHelpers.sol";

contract RiskParamsTest is Test {
    address owner = makeAddr("owner");
    address forwarder = makeAddr("creForwarder");
    RiskParams risk;

    function setUp() public {
        vm.warp(1_800_000_000);
        risk = new RiskParams(owner, forwarder, DeployHelpers.defaultRisk());
    }

    function test_get_returnsWhatWasSet() public view {
        RiskParams.Params memory p = risk.get();
        assertEq(p.maxUnhedged, 2000);
        assertEq(p.maxTries, 3);
        assertEq(p.transitBlocks, 1);
        assertEq(risk.owner(), owner);
        assertEq(risk.getForwarderAddress(), forwarder);
    }

    function test_setParams_onlyOwner() public {
        RiskParams.Params memory p = DeployHelpers.defaultRisk();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        risk.setParams(p);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        risk.setMarketOpen(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        risk.setMaxReportAge(0);
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

    // ─── Chainlink CRE report ───

    function test_report_onlyThroughTheForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
        risk.onReport("", _payload(true, 1000e6, uint64(block.timestamp)));
    }

    function test_report_lowersMaxLiquidationToTheHedgeCapacity() public {
        _report(true, 1234e6, block.timestamp);
        assertEq(risk.get().maxLiquidation, 1234e6);
        assertEq(risk.params().maxLiquidation, 50_000e6, "the owner's cap is kept");

        // more depth than the owner's cap never raises it
        _report(true, 1_000_000e6, block.timestamp + 1);
        assertEq(risk.get().maxLiquidation, 50_000e6);
    }

    function test_report_replacesTheOwnersMarketFlag() public {
        vm.prank(owner);
        risk.setMarketOpen(true);
        _report(false, 1000e6, block.timestamp);
        assertFalse(risk.marketOpen());
        assertEq(risk.cooldown(), 300);

        _report(true, 1000e6, block.timestamp + 1);
        assertTrue(risk.marketOpen());
    }

    function test_staleReport_failsClosed() public {
        _report(true, 1000e6, block.timestamp);
        vm.warp(block.timestamp + risk.maxReportAge());
        assertTrue(risk.marketOpen(), "fresh up to maxReportAge");
        assertEq(risk.get().maxLiquidation, 1000e6);

        vm.warp(block.timestamp + 1);
        assertFalse(risk.marketOpen(), "stale: after-hours pricing");
        assertEq(risk.get().maxLiquidation, 0, "stale: no liquidations");
    }

    function test_maxReportAgeZero_turnsTheFeedOff() public {
        _report(false, 1, block.timestamp);
        vm.startPrank(owner);
        risk.setMarketOpen(true);
        risk.setMaxReportAge(0);
        vm.stopPrank();
        assertTrue(risk.marketOpen());
        assertEq(risk.get().maxLiquidation, 50_000e6);
    }

    function test_report_rejectsReplaysAndFutureObservations() public {
        _report(true, 1000e6, block.timestamp);

        bytes memory replay = _payload(false, 1, uint64(block.timestamp));
        vm.prank(forwarder);
        vm.expectRevert(RiskParams.ReportOutOfOrder.selector);
        risk.onReport("", replay);

        bytes memory future = _payload(false, 1, uint64(block.timestamp + 61));
        vm.prank(forwarder);
        vm.expectRevert(RiskParams.ReportFromFuture.selector);
        risk.onReport("", future);
    }

    /// @dev The exact bytes packages/cre/test/workflow.test.ts expects `encodeMarketReport` to produce.
    function test_report_decodesTheWorkflowsBytes() public {
        vm.prank(forwarder);
        risk.onReport(
            "",
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"00000000000000000000000000000000000000000000000000000000498d5880"
            hex"000000000000000000000000000000000000000000000000000000006b49d200"
        );
        (bool open, uint64 observedAt, uint128 cap) = risk.lastReport();
        assertTrue(open);
        assertEq(cap, 1234e6);
        assertEq(observedAt, 1_800_000_000);
    }

    function test_report_capacityAboveUint128Saturates() public {
        _report(true, type(uint256).max, block.timestamp);
        (,, uint128 cap) = risk.lastReport();
        assertEq(cap, type(uint128).max);
    }

    /// @dev CRE metadata is abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner): 62 bytes.
    function test_report_pinsTheWorkflowId() public {
        bytes32 workflowId = bytes32(uint256(0x1234));
        vm.prank(owner);
        risk.setExpectedWorkflowId(workflowId);

        bytes memory metadata = abi.encodePacked(workflowId, bytes10("seiz3"), address(0xA11CE));
        assertEq(metadata.length, 62);
        vm.prank(forwarder);
        risk.onReport(metadata, _payload(true, 1000e6, uint64(block.timestamp)));
        assertTrue(risk.marketOpen());

        bytes32 wrong = bytes32(uint256(0xBAD));
        bytes memory payload = _payload(false, 1, uint64(block.timestamp + 1));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowId.selector, wrong, workflowId));
        risk.onReport(abi.encodePacked(wrong, bytes10("seiz3"), address(0xA11CE)), payload);
    }

    function _report(bool open, uint256 capacity, uint256 observedAt) internal {
        vm.prank(forwarder);
        risk.onReport("", _payload(open, capacity, uint64(observedAt)));
    }

    function _payload(bool open, uint256 capacity, uint64 observedAt) internal pure returns (bytes memory) {
        return abi.encode(open, capacity, observedAt);
    }

    function _expectInvalid(RiskParams.Params memory p) internal {
        vm.prank(owner);
        vm.expectRevert(RiskParams.InvalidParams.selector);
        risk.setParams(p);
    }
}
