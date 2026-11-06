import {
  erc20Abi,
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type PublicClient,
  type ReadContractParameters,
} from "viem";
import {
  afterbellVaultAbi,
  demoOracleAbi,
  iMorphoAbi,
  riskParamsAbi,
} from "@afterbell/shared/abis";

import { borrowAssetsOf, buildReports, mergeCandidates } from "./riskCalc.js";
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

const MAX_BORROWERS = 50;

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

  const [riskRaw, marketOpen, idleUsdc, price] = await multiCall(publicClient, blockNumber, [
    read({ address: risk, abi: riskParamsAbi, functionName: "get" }),
    read({ address: risk, abi: riskParamsAbi, functionName: "marketOpen" }),
    read({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault] }),
    // Any Morpho IOracle; the demo markets use DemoOracle, whose ABI carries the same price().
    read({ address: oracle, abi: demoOracleAbi, functionName: "price" }),
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

  const totals = requireResult(marketRaw, "morpho.market");
  const totalBorrowAssets = tupleBig(totals, 2, "totalBorrowAssets");
  const totalBorrowShares = tupleBig(totals, 3, "totalBorrowShares");
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

interface RealMarketRead {
  readonly mode: "real";
  readonly price: bigint;
  readonly lltv: bigint;
  readonly totalBorrowAssets: bigint;
  readonly totalBorrowShares: bigint;
}

interface MockMarketRead {
  readonly mode: "mock";
  readonly price: bigint;
  readonly lltv: bigint;
}

type MarketRead = RealMarketRead | MockMarketRead;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_MARKET_ID = `0x${"0".repeat(64)}`;
const BORROW_VIRTUAL_SHARES = 1_000_000n;
const BORROW_VIRTUAL_ASSETS = 1n;

async function readMarket(
  publicClient: PublicClient,
  blockNumber: bigint,
  cfg: Config,
  marketId: Hex,
): Promise<MarketRead> {
  if (marketId.toLowerCase() !== ZERO_MARKET_ID) {
    const [paramsResult, marketResult] = await multiCall(publicClient, blockNumber, [
      {
        address: cfg.morpho,
        abi: morphoBlueAbi,
        functionName: "idToMarketParams",
        args: [marketId],
      },
      {
        address: cfg.morpho,
        abi: morphoBlueAbi,
        functionName: "market",
        args: [marketId],
      },
    ]);

    if (paramsResult?.status === "success" && marketResult?.status === "success") {
      const oracle = tupleValue(paramsResult.result, 2, "oracle");
      const lltv = tupleBig(paramsResult.result, 4, "lltv");
      if (typeof oracle === "string" && oracle.toLowerCase() !== ZERO_ADDRESS && lltv > 0n) {
        const priceResult = await multiCall(publicClient, blockNumber, [
          { address: oracle as Address, abi: oracleAbi, functionName: "price" },
        ]);
        if (priceResult[0]?.status === "success") {
          const price = asBigInt(priceResult[0].result, "oracle.price");
          if (price > 0n) {
            return {
              mode: "real",
              price,
              lltv,
              totalBorrowAssets: tupleBig(marketResult.result, 2, "totalBorrowAssets"),
              totalBorrowShares: tupleBig(marketResult.result, 3, "totalBorrowShares"),
            };
          }
        }
      }
    }
  }

  const [priceResult, lltvResult] = await multiCall(publicClient, blockNumber, [
    { address: cfg.morpho, abi: morphoAbi, functionName: "price" },
    { address: cfg.morpho, abi: morphoAbi, functionName: "lltv" },
  ]);
  if (priceResult?.status !== "success" || lltvResult?.status !== "success") {
    throw new Error(
      "cannot read market: set MARKET_ID for real Morpho Blue, or use a mock exposing price()/lltv()",
    );
  }
  return {
    mode: "mock",
    price: asBigInt(priceResult.result, "morpho.price"),
    lltv: asBigInt(lltvResult.result, "morpho.lltv"),
  };
}

function borrowSharesToAssets(
  shares: bigint,
  totalAssets: bigint,
  totalShares: bigint,
): bigint {
  if (shares <= 0n || totalAssets <= 0n) return 0n;
  const denominator = totalShares + BORROW_VIRTUAL_SHARES;
  const numerator = shares * (totalAssets + BORROW_VIRTUAL_ASSETS);
  return (numerator + denominator - 1n) / denominator;
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

async function readBorrowersBlue(
  publicClient: PublicClient,
  blockNumber: bigint,
  cfg: Config,
  marketId: Hex,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
  addresses: readonly Address[],
): Promise<BorrowerState[]> {
  if (addresses.length === 0) return [];
  const results = await multiCall(
    publicClient,
    blockNumber,
    addresses.map((address) => ({
      address: cfg.morpho,
      abi: morphoBlueAbi,
      functionName: "position" as const,
      args: [marketId, address] as const,
    })),
  );

  const borrowers: BorrowerState[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result === undefined || result.status !== "success") continue;
    const address = addresses[i];
    if (address === undefined) continue;
    borrowers.push({
      address,
      collateral: tupleBig(result.result, 2, "collateral"),
      borrowAssets: borrowSharesToAssets(
        tupleBig(result.result, 1, "borrowShares"),
        totalBorrowAssets,
        totalBorrowShares,
      ),
    });
  }
  return borrowers;
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
    ContractFunctionName<typeof afterbellVaultAbi, "pure" | "view">,
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
  return read({ address, abi: afterbellVaultAbi, functionName });
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
