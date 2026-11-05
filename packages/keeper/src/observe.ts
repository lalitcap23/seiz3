import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";

import type { BreakerSnapshot } from "./breaker.js";
import type { Config, VaultState } from "./types.js";

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

export type LogSink = (line: string) => void;

export class Logger {
  private readonly sink: LogSink;

  constructor(sink: LogSink = (line) => process.stdout.write(`${line}\n`)) {
    this.sink = sink;
  }

  line(record: Record<string, unknown>): void {
    this.sink(serializeJson({ ts: Date.now(), ...record }));
  }

  decision(record: Record<string, unknown>): void {
    this.line(record);
  }

  error(record: Record<string, unknown>): void {
    process.stderr.write(`${serializeJson({ ts: Date.now(), level: "error", ...record })}\n`);
  }
}

export function stateSnapshot(state: VaultState): Record<string, unknown> {
  return {
    blockNumber: state.blockNumber,
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
    borrowers: state.borrowers,
  };
}

export type MetricLabels = Readonly<Record<string, string>>;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, labels: MetricLabels = {}, by = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const body = entries.map(([k, v]) => `${k}="${v}"`).join(",");
  return `${name}{${body}}`;
}

export interface RiskEngineStatus {
  readonly url: string;
  readonly lastOkAtMs: number | null;
  readonly lastError: string | null;
  readonly lastLatencyMs: number | null;
}

export interface HealthStatus {
  readonly status: "starting" | "ok" | "stale" | "breaker-open" | "killed";
  readonly now: number;
  readonly lastTickAtMs: number | null;
  readonly lastTickAgeMs: number | null;
  readonly lastTickBlock: bigint | null;
  readonly lastAction: string | null;
  readonly lastReason: string | null;
  readonly paused: boolean | null;
  readonly dryRun: boolean;
  readonly killSwitch: boolean;
  readonly breaker: BreakerSnapshot;
  readonly riskEngine: RiskEngineStatus;
  readonly tickMs: number;
}

export interface HealthDeps {
  readonly breaker: () => BreakerSnapshot;
  readonly riskEngine: () => RiskEngineStatus;
  readonly killSwitch: () => boolean;
  readonly cfg: Pick<Config, "dryRun" | "tickMs" | "healthPort">;
}

export class Telemetry {
  private lastTickAtMs: number | null = null;
  private lastTickBlock: bigint | null = null;
  private lastAction: string | null = null;
  private lastReason: string | null = null;
  private paused: boolean | null = null;
  private server: Server | null = null;

  constructor(readonly metrics: Metrics = new Metrics()) {}

  tick(blockNumber: bigint | null, state: VaultState | null = null): void {
    this.lastTickAtMs = Date.now();
    this.lastTickBlock = blockNumber;
    if (state !== null) this.paused = state.paused;
  }

  decision(action: string | null, reason: string): void {
    this.lastAction = action;
    this.lastReason = reason;
  }

  snapshot(deps: HealthDeps): HealthStatus {
    const now = Date.now();
    const age = this.lastTickAtMs === null ? null : now - this.lastTickAtMs;
    const killed = deps.killSwitch();
    const breaker = deps.breaker();
    const staleAfter = Math.max(10_000, deps.cfg.tickMs * 5);
    const status = killed
      ? "killed"
      : breaker.open
        ? "breaker-open"
        : this.lastTickAtMs === null
          ? "starting"
          : age !== null && age > staleAfter
            ? "stale"
            : "ok";
    return {
      status,
      now,
      lastTickAtMs: this.lastTickAtMs,
      lastTickAgeMs: age,
      lastTickBlock: this.lastTickBlock,
      lastAction: this.lastAction,
      lastReason: this.lastReason,
      paused: this.paused,
      dryRun: deps.cfg.dryRun,
      killSwitch: killed,
      breaker,
      riskEngine: deps.riskEngine(),
      tickMs: deps.cfg.tickMs,
    };
  }

  startHealthServer(deps: HealthDeps): Server {
    if (this.server !== null) return this.server;
    this.server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(serializeJson(this.snapshot(deps)));
        return;
      }
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(this.metrics.render());
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(serializeJson({ error: "not found" }));
    });
    this.server.listen(deps.cfg.healthPort, "0.0.0.0");
    return this.server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function killSwitchActive(cfg: Pick<Config, "killSwitchEnv" | "killSwitchFile">): boolean {
  if (cfg.killSwitchEnv) return true;
  try {
    return existsSync(cfg.killSwitchFile);
  } catch {
    return false;
  }
}
