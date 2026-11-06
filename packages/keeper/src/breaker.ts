import type { Config } from "./types.js";

export type BreakerBlock = "breaker-open" | "rate-limit";

export interface BreakerSnapshot {
  readonly open: boolean;
  readonly consecutiveReverts: number;
  readonly actionsLastMinute: number;
  readonly maxActionsPerMinute: number;
  readonly maxConsecutiveReverts: number;
  readonly lastFailureAtMs: number | null;
}

export interface BreakerPermit {
  readonly ok: boolean;
  readonly reason?: BreakerBlock;
}

const WINDOW_MS = 60_000;

/**
 * Pure circuit breaker: all clocks are injected so every branch is testable.
 * It never talks to the chain.
 */
export class Breaker {
  private readonly maxConsecutiveReverts: number;
  private readonly maxActionsPerMinute: number;
  private consecutiveReverts = 0;
  private readonly actionTimes: number[] = [];
  private lastFailureAtMs: number | null = null;

  constructor(cfg: Pick<Config, "maxConsecutiveReverts" | "maxActionsPerMinute">) {
    this.maxConsecutiveReverts = cfg.maxConsecutiveReverts;
    this.maxActionsPerMinute = cfg.maxActionsPerMinute;
  }

  canSend(nowMs: number): BreakerPermit {
    if (this.isOpen()) return { ok: false, reason: "breaker-open" };
    if (this.actionsLastMinute(nowMs) >= this.maxActionsPerMinute) {
      return { ok: false, reason: "rate-limit" };
    }
    return { ok: true };
  }

  recordAction(nowMs: number): void {
    this.actionTimes.push(nowMs);
    this.prune(nowMs);
  }

  recordSuccess(): void {
    this.consecutiveReverts = 0;
  }

  recordFailure(nowMs: number): void {
    this.consecutiveReverts += 1;
    this.lastFailureAtMs = nowMs;
  }

  isOpen(): boolean {
    return this.consecutiveReverts >= this.maxConsecutiveReverts;
  }

  actionsLastMinute(nowMs: number): number {
    this.prune(nowMs);
    return this.actionTimes.length;
  }

  snapshot(nowMs: number): BreakerSnapshot {
    return {
      open: this.isOpen(),
      consecutiveReverts: this.consecutiveReverts,
      actionsLastMinute: this.actionsLastMinute(nowMs),
      maxActionsPerMinute: this.maxActionsPerMinute,
      maxConsecutiveReverts: this.maxConsecutiveReverts,
      lastFailureAtMs: this.lastFailureAtMs,
    };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - WINDOW_MS;
    while (this.actionTimes.length > 0) {
      const first = this.actionTimes[0];
      if (first === undefined || first > cutoff) break;
      this.actionTimes.shift();
    }
  }
}
