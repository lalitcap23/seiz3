import type { PublicClient } from "viem";

import { morphoAbi, morphoBlueAbi, oracleAbi, vaultAbi } from "./abi.js";
import { buildReports, mergeCandidates } from "./riskCalc.js";
import { describeError } from "./riskEngine.js";
import type {
  Address,
  BorrowerState,
  Config,
  Hex,
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

export async function readState(
  publicClient: PublicClient,
  cfg: Config,
  now: bigint,
  extraBorrowers: readonly Address[] = [],
): Promise<ReadStateResult> {
  const blockNumber = await publicClient.getBlockNumber();

  const statics = await multiCall(publicClient, blockNumber, [
      { address: cfg.vault, abi: vaultAbi, functionName: "pendingHedge" },
      { address: cfg.vault, abi: vaultAbi, functionName: "inventory" },
      { address: cfg.vault, abi: vaultAbi, functionName: "confirmedShort" },
      { address: cfg.vault, abi: vaultAbi, functionName: "paused" },
      { address: cfg.vault, abi: vaultAbi, functionName: "lastUnwindAt" },
      { address: cfg.vault, abi: vaultAbi, functionName: "idleUsdc" },
      { address: cfg.vault, abi: vaultAbi, functionName: "coreUsdc" },
      { address: cfg.vault, abi: vaultAbi, functionName: "marginRatioBps" },
      { address: cfg.vault, abi: vaultAbi, functionName: "marketOpen" },
      { address: cfg.vault, abi: vaultAbi, functionName: "risk" },
      { address: cfg.vault, abi: vaultAbi, functionName: "marketId" },
      { address: cfg.vault, abi: vaultAbi, functionName: "poolPriceInBand" },
    ]);

  const marketId = optionalResult(statics[10], cfg.deployments.marketId) as Hex;
  const marketRead = await readMarket(publicClient, blockNumber, cfg, marketId);

  const pendingRaw = requireResult(statics[0], "vault.pendingHedge");
  const riskRaw = requireResult(statics[9], "vault.risk");
  const pendingHedge: PendingHedge = {
    delta: tupleBig(pendingRaw, 0, "delta"),
    sentBlock: tupleBig(pendingRaw, 1, "sentBlock"),
    sentAt: tupleBig(pendingRaw, 2, "sentAt"),
    tries: tupleBig(pendingRaw, 3, "tries"),
  };

  const risk: Risk = {
    maxLiquidation: tupleBig(riskRaw, 0, "maxLiquidation"),
    hedgeLeverage: tupleBig(riskRaw, 1, "hedgeLeverage"),
    marginBufferBps: tupleBig(riskRaw, 2, "marginBufferBps"),
    maxUnhedgedBps: tupleBig(riskRaw, 3, "maxUnhedgedBps"),
    maxSlippageBps: tupleBig(riskRaw, 4, "maxSlippageBps"),
    oracleBandBps: tupleBig(riskRaw, 5, "oracleBandBps"),
    maxTries: tupleBig(riskRaw, 6, "maxTries"),
    orderDelaySec: tupleBig(riskRaw, 7, "orderDelaySec"),
    unwindCooldownSec: tupleBig(riskRaw, 8, "unwindCooldownSec"),
  };

  const onchainBorrowers =
    marketRead.mode === "mock"
      ? await readBorrowerAddresses(publicClient, cfg, blockNumber)
      : [];
  const candidates = mergeCandidates(cfg.deployments.borrowers, [
    ...onchainBorrowers,
    ...extraBorrowers,
  ]);
  const labels = new Map(
    cfg.deployments.borrowers
      .filter((b) => b.label !== undefined)
      .map((b) => [b.address.toLowerCase(), b.label as string]),
  );
  const borrowerAddresses = candidates.map((c) => c.address);
  const borrowers =
    marketRead.mode === "real"
      ? await readBorrowersBlue(
          publicClient,
          blockNumber,
          cfg,
          marketId,
          marketRead.totalBorrowAssets,
          marketRead.totalBorrowShares,
          borrowerAddresses,
        )
      : await readBorrowersMock(publicClient, cfg, blockNumber, borrowerAddresses);

  const market: MarketState = {
    id: marketId,
    price: marketRead.price,
    lltv: marketRead.lltv,
  };

  const state: VaultState = {
    blockNumber,
    vault: cfg.vault,
    pendingHedge,
    inventory: asBigInt(requireResult(statics[1], "vault.inventory"), "inventory"),
    confirmedShort: asSigned(requireResult(statics[2], "vault.confirmedShort"), "confirmedShort"),
    paused: asBool(requireResult(statics[3], "vault.paused"), "paused"),
    lastUnwindAt: asBigInt(requireResult(statics[4], "vault.lastUnwindAt"), "lastUnwindAt"),
    idleUsdc: asBigInt(requireResult(statics[5], "vault.idleUsdc"), "idleUsdc"),
    coreUsdc: asBigInt(requireResult(statics[6], "vault.coreUsdc"), "coreUsdc"),
    marginRatioBps: asBigInt(requireResult(statics[7], "vault.marginRatioBps"), "marginRatioBps"),
    marketOpen: asBool(requireResult(statics[8], "vault.marketOpen"), "marketOpen"),
    poolPriceInBand: asBool(optionalResult(statics[11], true), "poolPriceInBand"),
    risk,
    market,
    borrowers,
  };

  const reports = buildReports(borrowers, market, risk, labels);
  const scan: ScanReport = {
    ts: now,
    blockNumber,
    morpho: cfg.morpho,
    marketId: market.id,
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

async function readBorrowerAddresses(
  publicClient: PublicClient,
  cfg: Config,
  blockNumber: bigint,
): Promise<Address[]> {
  const countResult = await multiCall(publicClient, blockNumber, [
    { address: cfg.morpho, abi: morphoAbi, functionName: "borrowerCount" },
  ]);
  const count = asBigInt(optionalResult(countResult[0], 0n), "borrowerCount");
  const capped = count > BigInt(MAX_BORROWERS) ? BigInt(MAX_BORROWERS) : count;
  if (capped === 0n) return [];
  const indexes = Array.from({ length: Number(capped) }, (_v, i) => BigInt(i));
  const results = await multiCall(
    publicClient,
    blockNumber,
    indexes.map((index) => ({
      address: cfg.morpho,
      abi: morphoAbi,
      functionName: "borrowerAt" as const,
      args: [index] as const,
    })),
  );

  const addresses: Address[] = [];
  for (const result of results) {
    if (result.status !== "success") continue;
    if (typeof result.result === "string" && /^0x[0-9a-fA-F]{40}$/.test(result.result)) {
      addresses.push(result.result as Address);
    }
  }
  return addresses;
}

async function readBorrowersMock(
  publicClient: PublicClient,
  cfg: Config,
  blockNumber: bigint,
  addresses: readonly Address[],
): Promise<BorrowerState[]> {
  if (addresses.length === 0) return [];
  const results = await multiCall(
    publicClient,
    blockNumber,
    addresses.map((address) => ({
      address: cfg.morpho,
      abi: morphoAbi,
      functionName: "getBorrower" as const,
      args: [address] as const,
    })),
  );

  const borrowers: BorrowerState[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result === undefined || result.status !== "success") continue;
    const collateral = tupleBig(result.result, 0, "collateral");
    const borrowAssets = tupleBig(result.result, 1, "borrowAssets");
    const address = addresses[i];
    if (address === undefined) continue;
    borrowers.push({ address, collateral, borrowAssets });
  }
  return borrowers;
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
  readonly abi: readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
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
    // fall through to individual calls
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

function optionalResult<T>(result: CallResult | undefined, fallback: T): T {
  if (result === undefined || result.status !== "success") return fallback;
  return result.result as T;
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

function asSigned(value: unknown, name: string): bigint {
  return asBigInt(value, name);
}

function asBool(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${name} is not a boolean`);
}
