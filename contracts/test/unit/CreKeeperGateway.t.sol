// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";

import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";
import {CreKeeperGateway} from "../../src/cre/CreKeeperGateway.sol";
import {ReceiverTemplate} from "../../src/cre/ReceiverTemplate.sol";

/// @notice Proves the Solidity receiver decodes exactly what packages/cre/src/bindings.ts encodes:
///         abi.encode(bytes32 marketId, address borrower, uint256 seized), delivered as the raw
///         `report` argument with forwarder-supplied metadata.
contract CreKeeperGatewayTest is Test {
    address internal constant FORWARDER = address(0xF0);
    address internal constant MORPHO = address(0x1111);
    address internal constant VAULT = address(0x2222);

    bytes32 internal constant MARKET_ID = keccak256("afterbell-market-c");
    address internal constant BORROWER = address(0xB0B);
    uint256 internal constant SEIZED = 831_600_000_000_000_000;

    CreKeeperGateway internal gateway;

    function setUp() public {
        gateway = new CreKeeperGateway(FORWARDER, IMorpho(MORPHO), IAfterbellVault(VAULT));
        // Foundry rejects high-level calls to codeless addresses; give the vault a STOP byte.
        vm.etch(VAULT, hex"00");
    }

    function _params() internal pure returns (MarketParams memory) {
        return MarketParams({
            loanToken: address(0x1),
            collateralToken: address(0x2),
            oracle: address(0x3),
            irm: address(0x4),
            lltv: 0.77e18
        });
    }

    function _mockMarket(MarketParams memory mp) internal {
        vm.mockCall(
            MORPHO,
            abi.encodeCall(IMorpho.idToMarketParams, (Id.wrap(MARKET_ID))),
            abi.encode(mp)
        );
    }

    function test_forwardsRawReportToVault() public {
        MarketParams memory mp = _params();
        _mockMarket(mp);

        vm.expectCall(VAULT, abi.encodeCall(IAfterbellVault.liquidate, (mp, BORROWER, SEIZED)));
        vm.prank(FORWARDER);
        gateway.onReport("", abi.encode(MARKET_ID, BORROWER, SEIZED));
    }

    function test_rejectsNonForwarder() public {
        bytes memory payload = abi.encode(MARKET_ID, BORROWER, SEIZED);

        vm.expectRevert(
            abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), FORWARDER)
        );
        gateway.onReport("", payload);
    }

    function test_pinsWorkflowIdIn62ByteMetadata() public {
        bytes32 workflowId = bytes32(uint256(0x1234));
        bytes memory metadata =
            abi.encodePacked(workflowId, bytes10("afterbell"), address(0xA11CE));
        assertEq(metadata.length, 62, "CRE metadata is 32 + 10 + 20 bytes");

        gateway.setExpectedWorkflowId(workflowId);
        MarketParams memory mp = _params();
        _mockMarket(mp);

        // matching metadata → forwarded
        vm.expectCall(VAULT, abi.encodeCall(IAfterbellVault.liquidate, (mp, BORROWER, SEIZED)));
        vm.prank(FORWARDER);
        gateway.onReport(metadata, abi.encode(MARKET_ID, BORROWER, SEIZED));

        // wrong workflow id → rejected before touching Morpho or the vault
        bytes32 wrong = bytes32(uint256(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowId.selector, wrong, workflowId)
        );
        vm.prank(FORWARDER);
        gateway.onReport(
            abi.encodePacked(wrong, bytes10("afterbell"), address(0xA11CE)),
            abi.encode(MARKET_ID, BORROWER, SEIZED)
        );
    }
}
