// The workflow's on-chain side: one read of RiskParams (the hedge band the vault's IOC order uses) and the DON-signed
// write back to it. The KeystoneForwarder calls RiskParams.onReport(metadata, report) itself, so the payload is the
// raw abi.encode the contract decodes in `_processReport`, not calldata.

import {
  bytesToHex,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  type EVMClient,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";

/** RiskParams.params(): the owner's caps (contracts/src/RiskParams.sol `Params`). */
export const RISK_PARAMS_ABI = [
  {
    type: "function",
    name: "params",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "maxLiquidation", type: "uint256" },
          { name: "maxUnhedged", type: "uint64" },
          { name: "leverage", type: "uint16" },
          { name: "marginBufferBps", type: "uint16" },
          { name: "minDiscountBps", type: "uint16" },
          { name: "oracleBandBps", type: "uint16" },
          { name: "hedgeCapBps", type: "uint16" },
          { name: "maxSlippageBps", type: "uint16" },
          { name: "maxTries", type: "uint8" },
          { name: "orderDelaySec", type: "uint32" },
          { name: "cooldownOpenSec", type: "uint32" },
          { name: "cooldownClosedSec", type: "uint32" },
          { name: "withdrawReserve", type: "uint256" },
          { name: "maxImpactBps", type: "uint16" },
          { name: "transitBlocks", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

export interface MarketReport {
  readonly open: boolean;
  readonly hedgeCapacity: bigint; // USDC 6 dec
  readonly observedAt: number; // unix seconds
}

export function encodeMarketReport(r: MarketReport): Hex {
  return encodeAbiParameters(
    [{ type: "bool" }, { type: "uint256" }, { type: "uint64" }],
    [r.open, r.hedgeCapacity, BigInt(r.observedAt)],
  );
}

/** The two bands the workflow works within, from the contract that enforces them. */
export interface RiskBands {
  readonly hedgeCapBps: bigint; // the vault's IOC hedge sells down to oracle × (1 − hedgeCapBps)
  readonly oracleBandBps: bigint; // the gap the vault tolerates between its prices and HyperCore's oracle
}

/**
 * @param at the block to read at: the last finalized one, or the latest (Base Sepolia, whose finalized head trails
 *           by hours: a fresh deployment wouldn't exist there yet). The bands are the owner's settings, which rarely
 *           change, so the latest block is safe to agree on.
 */
export function readRiskBands(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  riskParams: Address,
  at: "finalized" | "latest" = "finalized",
): RiskBands {
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: riskParams,
        data: encodeFunctionData({ abi: RISK_PARAMS_ABI, functionName: "params" }),
      }),
      blockNumber: at === "latest" ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const p = decodeFunctionResult({ abi: RISK_PARAMS_ABI, functionName: "params", data: bytesToHex(reply.data) });
  return { hedgeCapBps: BigInt(p.hedgeCapBps), oracleBandBps: BigInt(p.oracleBandBps) };
}

export function writeMarketReport(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  riskParams: Address,
  r: MarketReport,
  gasLimit: string,
) {
  const signed = runtime.report(prepareReportRequest(encodeMarketReport(r))).result();
  return evm.writeReport(runtime, { receiver: riskParams, report: signed, gasConfig: { gasLimit } }).result();
}
