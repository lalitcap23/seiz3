import { describe, expect, it } from "vitest";

import { Breaker } from "../../src/breaker.js";
import { makeConfig } from "./fixtures.js";

const cfg = makeConfig({ maxConsecutiveReverts: 3, maxActionsPerMinute: 2 });

describe("breaker: consecutive reverts", () => {
  it("opens after the configured number of failures", () => {
    const breaker = new Breaker(cfg);
    const t = 1_000_000;

    breaker.recordFailure(t);
    breaker.recordFailure(t);
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure(t);
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.canSend(t)).toEqual({ ok: false, reason: "breaker-open" });
  });

  it("a success resets the failure streak", () => {
    const breaker = new Breaker(cfg);
    const t = 1_000_000;

    breaker.recordFailure(t);
    breaker.recordFailure(t);
    breaker.recordSuccess();
    breaker.recordFailure(t);
    breaker.recordFailure(t);

    expect(breaker.isOpen()).toBe(false);
  });

  it("snapshot exposes the failure count and limits", () => {
    const breaker = new Breaker(cfg);
    breaker.recordFailure(5_000);

    expect(breaker.snapshot(5_000)).toMatchObject({
      open: false,
      consecutiveReverts: 1,
      maxConsecutiveReverts: 3,
      maxActionsPerMinute: 2,
      lastFailureAtMs: 5_000,
    });
  });
});

describe("breaker: actions per minute", () => {
  it("caps actions inside the rolling minute", () => {
    const breaker = new Breaker(cfg);
    const t = 1_000_000;

    expect(breaker.canSend(t).ok).toBe(true);
    breaker.recordAction(t);
    breaker.recordAction(t + 1);
    expect(breaker.canSend(t + 2)).toEqual({ ok: false, reason: "rate-limit" });
  });

  it("frees capacity once the oldest action leaves the window", () => {
    const breaker = new Breaker(cfg);
    const t = 1_000_000;

    breaker.recordAction(t);
    breaker.recordAction(t + 1);
    expect(breaker.canSend(t + 59_999).ok).toBe(false);
    expect(breaker.canSend(t + 60_001).ok).toBe(true);
  });

  it("reports the in-window action count", () => {
    const breaker = new Breaker(cfg);
    const t = 1_000_000;

    breaker.recordAction(t);
    breaker.recordAction(t + 30_000);
    breaker.recordAction(t + 70_000);

    expect(breaker.actionsLastMinute(t + 70_000)).toBe(2);
  });
});
