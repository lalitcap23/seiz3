import {
  erc20Abi,
  parseAbi,
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type PublicClient,
  type ReadContractParameters,
} from "viem";
import {
  seiz3VaultRemoteAbi,
  demoOracleAbi,
  iMorphoAbi,
  riskParamsAbi,
} from "@seiz3/shared/abis";

import { accruedBorrowAssets, borrowAssetsOf, buildReports, mergeCandidates } from "./riskCalc.js";
import { describeError } from "./riskEngine.js";
import type {
  Address,
  BorrowerState,
  Config,
  MarketState,
  PendingHedge,
  Risk,
  ScanReport,
  VaultState,
} from "./types.js";

// one multicall of Morpho positions per tick; Borrow-event discovery (borrowerScan.ts) feeds most of them
const MAX_BORROWERS = 200;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)",
]);

interface Success {
  readonly status: "success";
  readonly result: unknown;
}
interface Failure {
  readonly status: "failure";
  readonly error: Error;
}
type CallResult = Success | Failure;

export interface ReadStateResult {
  readonly state: VaultState;
  readonly scan: ScanReport;
}

/**
 * One tick's view of the chain, all at the latest block. Every read goes through `read()`, so the
 * function names and args are checked against the wagmi-generated ABIs at compile time.
 */
export async function readState(
  publicClient: PublicClient,
  cfg: Config,
  extraBorrowers: readonly Address[] = [],
): Promise<ReadStateResult> {
  const block = await publicClient.getBlock();
  const blockNumber = block.number;
  const marketId = cfg.deployments.marketId;
  const candidates = mergeCandidates(cfg.deployments.borrowers, extraBorrowers).slice(0, MAX_BORROWERS);

  const vault = (functionName: Parameters<typeof vaultRead>[1]) => vaultRead(cfg.vault, functionName);
  const [
    pendingRaw,
    inventory,
    confirmedShort,
    pauseFlags,
    lastUnwindAt,
    coreUsdc,
    marginShortfall,
    marginTarget,
    riskAddress,
    usdcAddress,
    paramsRaw,
    marketRaw,
    ...positions
  ] = await multiCall(publicClient, blockNumber, [
    vault("pendingHedge"),
    vault("inventory"),
    vault("confirmedShort"),
    vault("pauseFlags"),
    vault("lastUnwindAt"),
    vault("coreUsdc"),
    vault("marginShortfall"),
    vault("marginTarget"),
    vault("risk"),
    vault("usdc"),
    read({ address: cfg.morpho, abi: iMorphoAbi, functionName: "idToMarketParams", args: [marketId] }),
    read({ address: cfg.morpho, abi: iMorphoAbi, functionName: "market", args: [marketId] }),
    ...candidates.map((c) =>
      read({ address: cfg.morpho, abi: iMorphoAbi, functionName: "position", args: [marketId, c.address] }),
    ),
  ]);

  const risk = asAddress(requireResult(riskAddress, "vault.risk"), "vault.risk");
  const usdc = asAddress(requireResult(usdcAddress, "vault.usdc"), "vault.usdc");
  const params = requireResult(paramsRaw, "morpho.idToMarketParams");
  const oracle = asAddress(tupleValue(params, 2, "oracle"), "market oracle");
  const irm = asAddress(tupleValue(params, 3, "irm"), "market irm");
  const totals = requireResult(marketRaw, "morpho.market");
  const stored = {
    totalSupplyAssets: tupleBig(totals, 0, "totalSupplyAssets"),
    totalSupplyShares: tupleBig(totals, 1, "totalSupplyShares"),
    totalBorrowAssets: tupleBig(totals, 2, "totalBorrowAssets"),
    totalBorrowShares: tupleBig(totals, 3, "totalBorrowShares"),
    lastUpdate: tupleBig(totals, 4, "lastUpdate"),
    fee: tupleBig(totals, 5, "fee"),
  };
  const marketParams = {
    loanToken: asAddress(tupleValue(params, 0, "loanToken"), "market loanToken"),
    collateralToken: asAddress(tupleValue(params, 1, "collateralToken"), "market collateralToken"),
    oracle,
    irm,
    lltv: tupleBig(params, 4, "lltv"),
  };

  const [riskRaw, marketOpen, idleUsdc, price, rateRaw] = await multiCall(publicClient, blockNumber, [
    read({ address: risk, abi: riskParamsAbi, functionName: "get" }),
    read({ address: risk, abi: riskParamsAbi, functionName: "marketOpen" }),
    read({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault] }),
    // Any Morpho IOracle; the demo markets use DemoOracle, whose ABI carries the same price().
    read({ address: oracle, abi: demoOracleAbi, functionName: "price" }),
    // Morpho passes the stored market to the IRM when it accrues, so the view gives the same rate
    ...(irm === ZERO_ADDRESS
      ? []
      : [read({ address: irm, abi: irmAbi, functionName: "borrowRateView", args: [marketParams, stored] })]),
  ]);

  const pending = requireResult(pendingRaw, "vault.pendingHedge");
  const pendingHedge: PendingHedge = {
    delta: tupleBig(pending, 0, "delta"),
    sentBlock: tupleBig(pending, 1, "sentBlock"),
    sentAt: tupleBig(pending, 2, "sentAt"),
    tries: tupleBig(pending, 3, "tries"),
  };

  const market: MarketState = {
    id: marketId,
    price: asBigInt(requireResult(price, "market oracle price"), "price"),
    lltv: tupleBig(params, 4, "lltv"),
  };

  // A failed rate read only means the debt shows without the interest since lastUpdate: fewer liquidations, not wrong ones.
  const borrowRate = rateRaw?.status === "success" ? asBigInt(rateRaw.result, "irm.borrowRateView") : 0n;
  const totalBorrowAssets = accruedBorrowAssets(
    stored.totalBorrowAssets,
    borrowRate,
    block.timestamp - stored.lastUpdate,
  );
  const totalBorrowShares = stored.totalBorrowShares;
  const borrowers: BorrowerState[] = [];
  candidates.forEach((candidate, i) => {
    const position = positions[i];
    if (position === undefined || position.status !== "success") return;
    borrowers.push({
      address: candidate.address,
      collateral: tupleBig(position.result, 2, "collateral"),
      borrowAssets: borrowAssetsOf(
        tupleBig(position.result, 1, "borrowShares"),
        totalBorrowAssets,
        totalBorrowShares,
      ),
    });
  });

  const state: VaultState = {
    blockNumber,
    blockTimestamp: block.timestamp,
    vault: cfg.vault,
    pendingHedge,
    inventory: asBigInt(requireResult(inventory, "vault.inventory"), "inventory"),
    confirmedShort: asBigInt(requireResult(confirmedShort, "vault.confirmedShort"), "confirmedShort"),
    pauseFlags: asBigInt(requireResult(pauseFlags, "vault.pauseFlags"), "pauseFlags"),
    lastUnwindAt: asBigInt(requireResult(lastUnwindAt, "vault.lastUnwindAt"), "lastUnwindAt"),
    idleUsdc: asBigInt(requireResult(idleUsdc, "usdc.balanceOf(vault)"), "idleUsdc"),
    coreUsdc: asBigInt(requireResult(coreUsdc, "vault.coreUsdc"), "coreUsdc"),
    marginShortfall: asBigInt(requireResult(marginShortfall, "vault.marginShortfall"), "marginShortfall"),
    marginTarget: asBigInt(requireResult(marginTarget, "vault.marginTarget"), "marginTarget"),
    marketOpen: asBool(requireResult(marketOpen, "risk.marketOpen"), "marketOpen"),
    risk: parseRisk(requireResult(riskRaw, "risk.get")),
    market,
    borrowers,
  };

  const labels = new Map(
    candidates
      .filter((c) => c.label !== undefined)
      .map((c) => [c.address.toLowerCase(), c.label as string]),
  );
  const reports = buildReports(state, labels);
  const scan: ScanReport = {
    ts: block.timestamp,
    blockNumber,
    morpho: cfg.morpho,
    marketId,
    price: market.price,
    lltv: market.lltv,
    borrowers: reports,
    liquidatableCount: reports.filter((b) => b.liquidatable).length,
  };

  return { state, scan };
}

/** RiskParams.Params, in struct order. */
function parseRisk(raw: unknown): Risk {
  return {
    maxLiquidation: tupleBig(raw, 0, "maxLiquidation"),
    maxUnhedged: tupleBig(raw, 1, "maxUnhedged"),
    leverage: tupleBig(raw, 2, "leverage"),
    marginBufferBps: tupleBig(raw, 3, "marginBufferBps"),
    minDiscountBps: tupleBig(raw, 4, "minDiscountBps"),
    oracleBandBps: tupleBig(raw, 5, "oracleBandBps"),
    hedgeCapBps: tupleBig(raw, 6, "hedgeCapBps"),
    maxSlippageBps: tupleBig(raw, 7, "maxSlippageBps"),
    maxTries: tupleBig(raw, 8, "maxTries"),
    orderDelaySec: tupleBig(raw, 9, "orderDelaySec"),
    cooldownOpenSec: tupleBig(raw, 10, "cooldownOpenSec"),
    cooldownClosedSec: tupleBig(raw, 11, "cooldownClosedSec"),
    withdrawReserve: tupleBig(raw, 12, "withdrawReserve"),
    maxImpactBps: tupleBig(raw, 13, "maxImpactBps"),
    transitBlocks: tupleBig(raw, 14, "transitBlocks"),
  };
}

interface ReadCall {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

/** Type-checks one read against its ABI (same signature as viem's readContract), then erases it for batching. */
function read<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, "pure" | "view">,
  const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
>(call: ReadContractParameters<abi, functionName, args>): ReadCall {
  return call as unknown as ReadCall;
}

/** Argument-free vault views. */
function vaultRead(
  address: Address,
  functionName: Extract<
    ContractFunctionName<typeof seiz3VaultRemoteAbi, "pure" | "view">,
    | "pendingHedge"
    | "inventory"
    | "confirmedShort"
    | "pauseFlags"
    | "lastUnwindAt"
    | "coreUsdc"
    | "marginShortfall"
    | "marginTarget"
    | "risk"
    | "usdc"
  >,
): ReadCall {
  return read({ address, abi: seiz3VaultRemoteAbi, functionName });
}

async function multiCall(
  publicClient: PublicClient,
  blockNumber: bigint,
  calls: readonly ReadCall[],
): Promise<CallResult[]> {
  try {
    const batched = (await publicClient.multicall({
      blockNumber,
      allowFailure: true,
      contracts: calls as never,
    })) as unknown as CallResult[];
    if (batched.length === calls.length && batched.some((result) => result.status === "success")) {
      return batched;
    }
  } catch {
    // fall through to individual calls (e.g. no Multicall3 on a local anvil)
  }

  {
    const results: CallResult[] = [];
    for (const call of calls) {
      try {
        const result = await publicClient.readContract({ ...call, blockNumber } as never);
        results.push({ status: "success", result });
      } catch (error) {
        results.push({
          status: "failure",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return results;
  }
}

function requireResult(result: CallResult | undefined, name: string): unknown {
  if (result === undefined) throw new Error(`missing multicall result for ${name}`);
  if (result.status !== "success") {
    throw new Error(`read ${name} failed: ${describeError(result.error)}`);
  }
  return result.result;
}

function tupleValue(raw: unknown, index: number, key: string): unknown {
  if (Array.isArray(raw)) return raw[index];
  if (raw !== null && typeof raw === "object" && key in raw) {
    return (raw as Record<string, unknown>)[key];
  }
  return undefined;
}

function tupleBig(raw: unknown, index: number, key: string): bigint {
  return asBigInt(tupleValue(raw, index, key), key);
}

function asBigInt(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${name} is not an integer`);
}

function asBool(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${name} is not a boolean`);
}

function asAddress(value: unknown, name: string): Address {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as Address;
  throw new Error(`${name} is not an address`);
}
