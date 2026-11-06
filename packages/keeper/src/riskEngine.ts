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
      paused: state.paused,
      lastUnwindAt: state.lastUnwindAt,
      idleUsdc: state.idleUsdc,
      coreUsdc: state.coreUsdc,
      marginRatioBps: state.marginRatioBps,
      marketOpen: state.marketOpen,
      poolPriceInBand: state.poolPriceInBand,
      risk: state.risk,
      market: state.market,
      borrowers: scan.borrowers,
    },
    keeper: {
      idleReserveUsdc: cfg.idleReserveUsdc,
      coreReserveUsdc: cfg.coreReserveUsdc,
      topUpUsdc: cfg.topUpUsdc,
      unwindCooldownOpenSec: cfg.unwindCooldownOpenSec,
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
    topUpUsdc: request.keeper.topUpUsdc,
    unwindCooldownOpenSec: request.keeper.unwindCooldownOpenSec,
  };
}

export function stateFromRiskRequest(request: RiskRequest): VaultState {
  const s = request.state;
  return {
    blockNumber: request.blockNumber,
    vault: request.vault,
    pendingHedge: s.pendingHedge,
    inventory: s.inventory,
    confirmedShort: s.confirmedShort,
    paused: s.paused,
    lastUnwindAt: s.lastUnwindAt,
    idleUsdc: s.idleUsdc,
    coreUsdc: s.coreUsdc,
    marginRatioBps: s.marginRatioBps,
    marketOpen: s.marketOpen,
    poolPriceInBand: s.poolPriceInBand,
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

  constructor(config: Pick<Config, "riskEngineUrl" | "riskEngineTimeoutMs" | "riskEngineRetries">) {
    this.url = config.riskEngineUrl.replace(/\/+$/, "");
    this.timeoutMs = config.riskEngineTimeoutMs;
    this.retries = config.riskEngineRetries;
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
          headers: { "content-type": "application/json" },
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
        })) as unknown;
        const decision = parseRiskDecision(json);
        return {
          ok: true,
          decision,
          latencyMs: Date.now() - started,
          attempts: attempt,
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
      return maybe.shortMessage;
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
  hedgeLeverage: zUint,
  marginBufferBps: zUint,
  maxUnhedgedBps: zUint,
  maxSlippageBps: zUint,
  oracleBandBps: zUint,
  maxTries: zUint,
  orderDelaySec: zUint,
  unwindCooldownSec: zUint,
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
    paused: z.boolean(),
    lastUnwindAt: zUint,
    idleUsdc: zUint,
    coreUsdc: zUint,
    marginRatioBps: zUint,
    marketOpen: z.boolean(),
    poolPriceInBand: z.boolean(),
    risk: riskSchema,
    market: marketSchema,
    borrowers: z.array(reportSchema),
  }),
  keeper: z.object({
    idleReserveUsdc: zUint,
    coreReserveUsdc: zUint,
    topUpUsdc: zUint,
    unwindCooldownOpenSec: zUint,
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
