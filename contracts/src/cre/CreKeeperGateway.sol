// SPDX-License-Identifier: MIT
// Receiver for the Afterbell CRE workflow (Chainlink Runtime Environment).
//
// Hackathon scope: compiled, NOT deployed — the chainlink prize only requires a successful
// simulation. Production path: deploy behind the vault, set the forwarder to the Keystone
// Forwarder, and pin `expectedWorkflowId` (and optionally author/name) so only reports from
// this exact workflow can move funds.
//
// Flow: CRE DON co-signs a report → KeystoneForwarder verifies the signatures → this
// gateway's onReport → AfterbellVault.liquidate. The vault re-checks every rule on-chain
// (allow-listed market, oracle band, notional cap, margin); this contract only authenticates
// the report and forwards it.
//
// Report layout (encoded by packages/cre/src/bindings.ts):
//   abi.encode(bytes32 marketId, address borrower, uint256 seized)
//
// ReceiverTemplate is Chainlink's official reference implementation (MIT), copied verbatim:
// https://docs.chain.link/cre
pragma solidity ^0.8.28;

import {IMorpho, Id, MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {IAfterbellVault} from "../interfaces/IAfterbellVault.sol";
import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/// @notice The vault's single entry point for CRE-originated liquidations.
contract CreKeeperGateway is ReceiverTemplate {
    IMorpho public immutable morpho;
    IAfterbellVault public immutable vault;

    event LiquidationForwarded(bytes32 indexed marketId, address indexed borrower, uint256 seized);

    constructor(address forwarder_, IMorpho morpho_, IAfterbellVault vault_) ReceiverTemplate(forwarder_) {
        morpho = morpho_;
        vault = vault_;
    }

    function _processReport(bytes calldata report) internal override {
        (bytes32 marketId, address borrower, uint256 seized) = abi.decode(report, (bytes32, address, uint256));
        MarketParams memory params = morpho.idToMarketParams(Id.wrap(marketId));
        vault.liquidate(params, borrower, seized);
        emit LiquidationForwarded(marketId, borrower, seized);
    }
}
