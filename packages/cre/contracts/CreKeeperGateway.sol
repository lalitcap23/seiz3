// SPDX-License-Identifier: MIT
// Reference receiver for the Afterbell CRE workflow (hackathon scope: NOT deployed — the workflow
// simulates the write). Extends Chainlink's ReceiverTemplate so only DON-signed reports (via the
// KeystoneForwarder, optionally pinned to a workflow id/author) reach the vault.
//
// Report layout (encoded by packages/cre/src/bindings.ts):
//   abi.encode(bytes32 marketId, address borrower, uint256 seized)
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMorpho, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IAfterbellVault} from "../../src/interfaces/IAfterbellVault.sol";

/// @notice Minimal ReceiverTemplate implementation: DON-signed liquidation instructions → AfterbellVault.
abstract contract ReceiverTemplate is Ownable {
    address public forwarder;
    bytes32 public expectedWorkflowId;

    error InvalidSender(address sender, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);

    constructor(address forwarder_) Ownable(msg.sender) {
        forwarder = forwarder_;
    }

    function setForwarder(address f) external onlyOwner {
        forwarder = f;
    }

    function setExpectedWorkflowId(bytes32 id) external onlyOwner {
        expectedWorkflowId = id;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external virtual {
        if (forwarder != address(0) && msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        if (expectedWorkflowId != bytes32(0)) {
            bytes32 workflowId = _decodeWorkflowId(metadata);
            if (workflowId != expectedWorkflowId) revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }
        _processReport(report);
    }

    function _decodeWorkflowId(bytes memory metadata) internal pure returns (bytes32 id) {
        // CRE metadata layout: (bytes32 workflowId, bytes10 name, address owner)
        if (metadata.length < 86) return bytes32(0);
        assembly {
            id := mload(add(metadata, 32))
        }
    }

    function _processReport(bytes calldata report) internal virtual;
}

/// @notice The vault's single entry point for CRE-originated liquidations.
/// @dev The vault re-checks every rule on-chain (allow-listed market, oracle band, caps, margin) —
///      this gateway only authenticates the report and forwards it.
contract CreKeeperGateway is ReceiverTemplate {
    IMorpho public immutable morpho;
    IAfterbellVault public immutable vault;

    event LiquidationForwarded(bytes32 indexed marketId, address indexed borrower, uint256 seized);

    constructor(address forwarder_, IMorpho morpho_, IAfterbellVault vault_)
        ReceiverTemplate(forwarder_)
    {
        morpho = morpho_;
        vault = vault_;
    }

    function _processReport(bytes calldata report) internal override {
        (bytes32 marketId, address borrower, uint256 seized) = abi.decode(report, (bytes32, address, uint256));
        MarketParams memory params = morpho.idToMarketParams(marketId);
        vault.liquidate(params, borrower, seized);
        emit LiquidationForwarded(marketId, borrower, seized);
    }
}
