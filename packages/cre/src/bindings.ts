// EVM bindings for the Afterbell CRE workflow: reads on Morpho Blue / DemoOracle and the
// DON-signed write to the vault via CreKeeperGateway (KeystoneForwarder → onReport → vault.liquidate).
//
// The read pattern is the CRE SDK idiom: encodeFunctionData → client.callContract(runtime, …) →
// bytesToHex(result.data) → decodeFunctionResult. The write pattern: runtime.report(prepareReportRequest)
// → client.writeReport(runtime, { receiver: gateway, … }).

import {
  bytesToHex,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  TxStatus,
  type EVMClient,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, zeroAddress } from "viem";
import type { Address, Hex } from "viem";

export const MORPHO_POSITION_ABI = [
  {
    type: "function",
    name: "position",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "idToMarketParams",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export const ORACLE_PRICE_ABI = [
  {
    type: "function",
    name: "price",
    inputs: [],
    outputs: [{ name: "price", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const GATEWAY_ONREPORT_ABI = [
  {
    type: "function",
    name: "onReport",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export interface Position {
  readonly supplyShares: bigint;
  readonly borrowShares: bigint;
  readonly collateral: bigint;
}

export interface MarketParams {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: bigint;
}

export interface WriteResult {
  readonly txStatus: TxStatus;
  readonly txHash?: Uint8Array;
}

/**
 * All on-chain interaction for the workflow. In offline simulations (vitest, CRE CLI local mode)
 * the methods are overridden by test doubles — nothing reaches a network.
 */
export class AfterbellBindings {
  readonly client: EVMClient;
  readonly morpho: Address;
  readonly gateway: Address;

  constructor(client: EVMClient, morpho: Address, gateway: Address) {
    this.client = client;
    this.morpho = morpho;
    this.gateway = gateway;
  }

  position(runtime: Runtime<unknown>, marketId: Hex, borrower: Address): Position {
    const callData = encodeFunctionData({
      abi: MORPHO_POSITION_ABI,
      functionName: "position",
      args: [marketId, borrower],
    });
    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.morpho, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    const [supplyShares, borrowShares, collateral] = decodeFunctionResult({
      abi: MORPHO_POSITION_ABI,
      functionName: "position",
      data: bytesToHex(result.data),
    });
    return { supplyShares, borrowShares, collateral };
  }

  marketParams(runtime: Runtime<unknown>, marketId: Hex): MarketParams {
    const callData = encodeFunctionData({
      abi: MORPHO_POSITION_ABI,
      functionName: "idToMarketParams",
      args: [marketId],
    });
    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.morpho, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    const [loanToken, collateralToken, oracle, irm, lltv] = decodeFunctionResult({
      abi: MORPHO_POSITION_ABI,
      functionName: "idToMarketParams",
      data: bytesToHex(result.data),
    });
    return { loanToken, collateralToken, oracle, irm, lltv };
  }

  /** DemoOracle.price() is USD × 1e24 for the 6/18-dec pair (see contracts/src/mocks/DemoOracle.sol). */
  lendingPriceRaw(runtime: Runtime<unknown>, oracle: Address): bigint {
    const callData = encodeFunctionData({ abi: ORACLE_PRICE_ABI, functionName: "price" });
    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: oracle, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({ abi: ORACLE_PRICE_ABI, functionName: "price", data: bytesToHex(result.data) });
  }

  /** DON-signed report → CreKeeperGateway.onReport → AfterbellVault.liquidate. */
  writeLiquidation(
    runtime: Runtime<unknown>,
    marketId: Hex,
    borrower: Address,
    seized: bigint,
  ): WriteResult {
    const report = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [marketId, borrower, seized],
    );
    const callData = encodeFunctionData({
      abi: GATEWAY_ONREPORT_ABI,
      functionName: "onReport",
      args: ["0x", report],
    });
    const reportResponse = runtime.report(prepareReportRequest(callData)).result();
    return this.client
      .writeReport(runtime, {
        receiver: this.gateway,
        report: reportResponse,
        gasConfig: { gasLimit: "1_500_000" },
      })
      .result();
  }
}
