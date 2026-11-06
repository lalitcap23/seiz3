import type { PublicClient } from "viem";

import { morphoAbi, vaultAbi } from "./abi.js";
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
      { address: cfg.morpho, abi: morphoAbi, functionName: "price" },
      { address: cfg.morpho, abi: morphoAbi, functionName: "lltv" },
      { address: cfg.morpho, abi: morphoAbi, functionName: "borrowerCount" },
    ]);

  const pendingRaw = requireResult(statics[0], "vault.pendingHedge");
  const riskRaw = requireResult(statics[9], "vault.risk");
  const price = asBigInt(requireResult(statics[12], "morpho.price"), "morpho.price");
  const lltv = asBigInt(requireResult(statics[13], "morpho.lltv"), "morpho.lltv");
  const borrowerCount = asBigInt(requireResult(statics[14], "morpho.borrowerCount"), "borrowerCount");

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

  const onchainBorrowers = await readBorrowerAddresses(
    publicClient,
    cfg,
    blockNumber,
    borrowerCount,
  );
  const candidates = mergeCandidates(cfg.deployments.borrowers, [
    ...onchainBorrowers,
    ...extraBorrowers,
  ]);
  const labels = new Map(
    cfg.deployments.borrowers
      .filter((b) => b.label !== undefined)
      .map((b) => [b.address.toLowerCase(), b.label as string]),
  );
  const borrowers = await readBorrowers(
    publicClient,
    cfg,
    blockNumber,
    candidates.map((c) => c.address),
  );

  const market: MarketState = {
    id: optionalResult(statics[10], cfg.deployments.marketId) as Hex,
    price,
    lltv,
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

async function readBorrowerAddresses(
  publicClient: PublicClient,
  cfg: Config,
  blockNumber: bigint,
  count: bigint,
): Promise<Address[]> {
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

async function readBorrowers(
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
