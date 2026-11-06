import { BaseError, ContractFunctionRevertedError } from "viem";
import { z } from "zod";
import type {
  Action,
  Address,
  Config,
  Hex,
  PolicyConfig,
  RiskDecision,
  RiskRequest,
  ScanReport,
  VaultState,
} from "./types.js";

export interface RiskEngineOk {
  readonly ok: true;
  readonly decision: RiskDecision;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Leader election: this keeper's role and the elected leader, per the risk engine. */
  readonly role: "leader" | "follower" | null;
  readonly leaderId: string | null;
}

export interface RiskEngineErr {
  readonly ok: false;
  readonly error: string;
  readonly retriable: boolean;
  readonly attempts: number;
}

export type RiskEngineResult = RiskEngineOk | RiskEngineErr;

export class RiskEngineProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskEngineProtocolError";
  }
}

export function buildRiskRequest(
  state: VaultState,
  scan: ScanReport,
  now: bigint,
  cfg: Config,
): RiskRequest {
  return {
    ts: BigInt(Date.now()),
    chainId: cfg.chainId,
    blockNumber: state.blockNumber,
    vault: state.vault,
    morpho: cfg.morpho,
    state: {
      pendingHedge: state.pendingHedge,
      inventory: state.inventory,
      confirmedShort: state.confirmedShort,
      pauseFlags: state.pauseFlags,
      lastUnwindAt: state.lastUnwindAt,
      idleUsdc: state.idleUsdc,
      coreUsdc: state.coreUsdc,
      marginShortfall: state.marginShortfall,
      marginTarget: state.marginTarget,
      marketOpen: state.marketOpen,
      risk: state.risk,
      market: state.market,
      borrowers: scan.borrowers,
    },
    keeper: {
      idleReserveUsdc: cfg.idleReserveUsdc,
      coreReserveUsdc: cfg.coreReserveUsdc,
      now,
    },
  };
}

export function serializeRiskRequest(request: RiskRequest): string {
  return JSON.stringify(request, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function policyConfigFromRequest(request: RiskRequest): PolicyConfig {
  return {
    idleReserveUsdc: request.keeper.idleReserveUsdc,
    coreReserveUsdc: request.keeper.coreReserveUsdc,
  };
}

export function stateFromRiskRequest(request: RiskRequest): VaultState {
  const s = request.state;
  return {
    blockNumber: request.blockNumber,
    blockTimestamp: request.keeper.now,
    vault: request.vault,
    pendingHedge: s.pendingHedge,
    inventory: s.inventory,
    confirmedShort: s.confirmedShort,
    pauseFlags: s.pauseFlags,
    lastUnwindAt: s.lastUnwindAt,
    idleUsdc: s.idleUsdc,
    coreUsdc: s.coreUsdc,
    marginShortfall: s.marginShortfall,
    marginTarget: s.marginTarget,
    marketOpen: s.marketOpen,
    risk: s.risk,
    market: s.market,
    borrowers: s.borrowers.map((b) => ({
      address: b.address,
      collateral: b.collateral,
      borrowAssets: b.borrowAssets,
    })),
  };
}

export function parseRiskDecision(value: unknown): RiskDecision {
  if (value === null || typeof value !== "object") {
    throw new RiskEngineProtocolError("decision must be an object");
  }
  const record = value as Record<string, unknown>;
  const reason = record["reason"];
  if (typeof reason !== "string" || reason.length === 0) {
    throw new RiskEngineProtocolError("decision.reason must be a non-empty string");
  }
  const action = parseAction(record["action"]);
  const confidence =
    record["confidenceBps"] === undefined ? undefined : toBigInt(record["confidenceBps"], "confidenceBps");
  const engineVersion = record["engineVersion"];
  if (engineVersion !== undefined && typeof engineVersion !== "string") {
    throw new RiskEngineProtocolError("decision.engineVersion must be a string");
  }
  return {
    action,
    reason,
    ...(confidence === undefined ? {} : { confidenceBps: confidence }),
    ...(engineVersion === undefined ? {} : { engineVersion }),
  };
}

function parseAction(value: unknown): Action | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw new RiskEngineProtocolError("decision.action must be an object or null");
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  switch (kind) {
    case "syncHedge":
      return { kind: "syncHedge" };
    case "unwindStep":
      return { kind: "unwindStep" };
    case "topUpMargin":
      return { kind: "topUpMargin", amount: toBigInt(record["amount"], "topUpMargin.amount") };
    case "withdrawMargin":
      return { kind: "withdrawMargin", amount: toBigInt(record["amount"], "withdrawMargin.amount") };
    case "liquidate": {
      const marketId = toHex32(record["marketId"], "liquidate.marketId");
      const borrower = toAddress(record["borrower"], "liquidate.borrower");
      const seizedAssets = toBigInt(record["seizedAssets"], "liquidate.seizedAssets");
      return { kind: "liquidate", marketId, borrower, seizedAssets };
    }
    default:
      throw new RiskEngineProtocolError(`unknown action kind: ${String(kind)}`);
  }
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new RiskEngineProtocolError(`${field} must be an integer string`);
}

function toAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new RiskEngineProtocolError(`${field} must be a 20-byte hex address`);
  }
  return value as Address;
}

function toHex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RiskEngineProtocolError(`${field} must be a 32-byte hex string`);
  }
  return value as Hex;
}

export class RiskEngineClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly keeperId: string;

  constructor(config: Pick<Config, "riskEngineUrl" | "riskEngineTimeoutMs" | "riskEngineRetries" | "keeperId">) {
    this.url = config.riskEngineUrl.replace(/\/+$/, "");
    this.timeoutMs = config.riskEngineTimeoutMs;
    this.retries = config.riskEngineRetries;
    this.keeperId = config.keeperId;
  }

  async decide(request: RiskRequest): Promise<RiskEngineResult> {
    const body = serializeRiskRequest(request);
    const attempts = this.retries + 1;
    let lastError = "risk engine request failed";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await fetch(`${this.url}/decide`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // heartbeat + identity: the risk engine elects a leader among the keepers it sees
            "x-keeper-id": this.keeperId,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          lastError = `risk engine HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`;
          const retriable = response.status >= 500 || response.status === 429;
          if (!retriable) return { ok: false, error: lastError, retriable: false, attempts: attempt };
          continue;
        }
        const json = (await response.json().catch(() => {
          throw new RiskEngineProtocolError("risk engine returned invalid JSON");
        })) as Record<string, unknown>;
        const decision = parseRiskDecision(json);
        return {
          ok: true,
          decision,
          latencyMs: Date.now() - started,
          attempts: attempt,
          role: json["role"] === "leader" || json["role"] === "follower" ? json["role"] : null,
          leaderId: typeof json["leaderId"] === "string" ? json["leaderId"] : null,
        };
      } catch (error) {
        if (error instanceof RiskEngineProtocolError) {
          return { ok: false, error: error.message, retriable: false, attempts: attempt };
        }
        lastError = describeError(error);
      }
    }

    return { ok: false, error: lastError, retriable: true, attempts };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const maybe = error as Error & { shortMessage?: string; cause?: unknown };
    if (typeof maybe.shortMessage === "string" && maybe.shortMessage.length > 0) {
      // viem's short message drops the decoded custom error (e.g. OracleBand); keep it in the log
      const revert = error instanceof BaseError
        ? error.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;
      const name = revert instanceof ContractFunctionRevertedError
        ? (revert.data?.errorName ?? revert.reason ?? revert.signature)
        : undefined;
      return name === undefined ? maybe.shortMessage : `${maybe.shortMessage} [${name}]`;
    }
    if (maybe.cause !== undefined && maybe.cause instanceof Error) {
      return `${error.message}: ${maybe.cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

const zBig = z
  .union([z.string().regex(/^-?\d+$/), z.number().int()])
  .transform((value) => BigInt(value));
const zUint = zBig.refine((value) => value >= 0n, "must be >= 0");
const zAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value as Address);
const zHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);

const pendingSchema = z.object({
  delta: zBig,
  sentBlock: zUint,
  sentAt: zUint,
  tries: zUint,
});

const riskSchema = z.object({
  maxLiquidation: zUint,
  maxUnhedged: zUint,
  leverage: zUint,
  marginBufferBps: zUint,
  minDiscountBps: zUint,
  oracleBandBps: zUint,
  hedgeCapBps: zUint,
  maxSlippageBps: zUint,
  maxTries: zUint,
  orderDelaySec: zUint,
  cooldownOpenSec: zUint,
  cooldownClosedSec: zUint,
  withdrawReserve: zUint,
  maxImpactBps: zUint,
  transitBlocks: zUint,
});

const marketSchema = z.object({ id: zHex32, price: zUint, lltv: zUint });

const reportSchema = z.object({
  address: zAddress,
  collateral: zUint,
  borrowAssets: zUint,
  lltv: zUint,
  lltvBps: zUint,
  collateralValueUsdc: zUint,
  ltvBps: zUint,
  liquidatable: z.boolean(),
  maxSeizedAssets: zUint,
  label: z.string().optional(),
});

const requestSchema = z.object({
  ts: zUint,
  chainId: zUint,
  blockNumber: zUint,
  vault: zAddress,
  morpho: zAddress,
  state: z.object({
    pendingHedge: pendingSchema,
    inventory: zUint,
    confirmedShort: zBig,
    pauseFlags: zUint,
    lastUnwindAt: zUint,
    idleUsdc: zUint,
    coreUsdc: zUint,
    marginShortfall: zUint,
    marginTarget: zUint,
    marketOpen: z.boolean(),
    risk: riskSchema,
    market: marketSchema,
    borrowers: z.array(reportSchema),
  }),
  keeper: z.object({
    idleReserveUsdc: zUint,
    coreReserveUsdc: zUint,
    now: zUint,
  }),
});

export function parseRiskRequest(value: unknown): RiskRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new RiskEngineProtocolError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data as RiskRequest;
}
