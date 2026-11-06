// EVM bindings for the Afterbell CRE workflow: reads on Morpho Blue / DemoOracle and the
// DON-signed write to the vault via CreKeeperGateway (KeystoneForwarder → onReport → vault.liquidate).
//
// Read pattern (CRE SDK idiom): encodeFunctionData → client.callContract(runtime, …) →
// bytesToHex(result.data) → decodeFunctionResult.
//
// Write pattern: runtime.report(prepareReportRequest(rawReportBytes)) → client.writeReport(...).
// The report payload is the *raw* abi.encode(marketId, borrower, seized) — NOT an onReport
// calldata wrapper. The forwarder calls gateway.onReport(metadata, report) itself and injects
// the trusted metadata; the gateway decodes `report` directly.

import {
  bytesToHex,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  type EVMClient,
  type Runtime,
  TxStatus,
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
  {
    type: "function",
    name: "market",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
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

/** The two fields needed for Morpho's shares → assets conversion. */
export interface MarketTotals {
  readonly totalBorrowAssets: bigint;
  readonly totalBorrowShares: bigint;
}

export interface WriteResult {
  readonly txStatus: TxStatus;
  readonly txHash?: Uint8Array;
}

/**
 * All on-chain interaction for the workflow. In offline simulations (vitest, CRE CLI local mode)
 * the write/read methods are overridden by test doubles — nothing reaches a network.
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

  private read(runtime: Runtime<unknown>, to: Address, data: Hex): Hex {
    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    return bytesToHex(result.data);
  }

  position(runtime: Runtime<unknown>, marketId: Hex, borrower: Address): Position {
    const callData = encodeFunctionData({
      abi: MORPHO_POSITION_ABI,
      functionName: "position",
      args: [marketId, borrower],
    });
    const [supplyShares, borrowShares, collateral] = decodeFunctionResult({
      abi: MORPHO_POSITION_ABI,
      functionName: "position",
      data: this.read(runtime, this.morpho, callData),
    });
    return { supplyShares, borrowShares, collateral };
  }

  marketParams(runtime: Runtime<unknown>, marketId: Hex): MarketParams {
    const callData = encodeFunctionData({
      abi: MORPHO_POSITION_ABI,
      functionName: "idToMarketParams",
      args: [marketId],
    });
    const [loanToken, collateralToken, oracle, irm, lltv] = decodeFunctionResult({
      abi: MORPHO_POSITION_ABI,
      functionName: "idToMarketParams",
      data: this.read(runtime, this.morpho, callData),
    });
    return { loanToken, collateralToken, oracle, irm, lltv };
  }

  market(runtime: Runtime<unknown>, marketId: Hex): MarketTotals {
    const callData = encodeFunctionData({
      abi: MORPHO_POSITION_ABI,
      functionName: "market",
      args: [marketId],
    });
    const [, , totalBorrowAssets, totalBorrowShares] = decodeFunctionResult({
      abi: MORPHO_POSITION_ABI,
      functionName: "market",
      data: this.read(runtime, this.morpho, callData),
    });
    return { totalBorrowAssets, totalBorrowShares };
  }

  /** DemoOracle.price() is USD × 1e24 for the 6/18-dec pair (see contracts/src/mocks/DemoOracle.sol). */
  lendingPriceRaw(runtime: Runtime<unknown>, oracle: Address): bigint {
    const callData = encodeFunctionData({ abi: ORACLE_PRICE_ABI, functionName: "price" });
    return decodeFunctionResult({
      abi: ORACLE_PRICE_ABI,
      functionName: "price",
      data: this.read(runtime, oracle, callData),
    });
  }

  /**
   * DON-signed report → CreKeeperGateway.onReport → AfterbellVault.liquidate.
   * The payload is raw ABI data: the forwarder supplies the trusted metadata argument.
   */
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
    const reportResponse = runtime.report(prepareReportRequest(report)).result();
    return this.client
      .writeReport(runtime, {
        receiver: this.gateway,
        report: reportResponse,
        gasConfig: { gasLimit: "1500000" },
      })
      .result();
  }
}
