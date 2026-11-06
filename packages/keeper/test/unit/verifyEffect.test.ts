import { describe, expect, it } from "vitest";

import { verifyEffect } from "../../src/executor.js";
import { PAUSE_MARGIN } from "../../src/riskCalc.js";
import type { Action } from "../../src/types.js";
import {
  BORROWER_A,
  MARKET_ID,
  USDC,
  NVDAX,
  makeState,
  readyPending,
} from "./fixtures.js";

const liquidation: Action = {
  kind: "liquidate",
  marketId: MARKET_ID,
  borrower: BORROWER_A,
  seizedAssets: NVDAX(9),
};

describe("executor: verifyEffect", () => {
  it("accepts a cleared pending hedge", () => {
    const before = makeState({ pendingHedge: readyPending() });
    const after = makeState();

    expect(verifyEffect(before, after, { kind: "syncHedge" })).toEqual({
      ok: true,
      detail: "pending cleared",
    });
  });

  it("accepts a retried pending hedge", () => {
    const before = makeState({ pendingHedge: readyPending({ tries: 1n }) });
    const after = makeState({ pendingHedge: readyPending({ tries: 2n }) });

    const result = verifyEffect(before, after, { kind: "syncHedge" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("1 -> 2");
  });

  it("rejects an unchanged pending hedge", () => {
    const state = makeState({ pendingHedge: readyPending() });

    expect(verifyEffect(state, state, { kind: "syncHedge" }).ok).toBe(false);
  });

  it("accepts a sync that clears a margin pause, and flags one that doesn't", () => {
    const before = makeState({ pauseFlags: PAUSE_MARGIN });

    expect(verifyEffect(before, makeState(), { kind: "syncHedge" })).toEqual({
      ok: true,
      detail: "pause cleared",
    });
    expect(verifyEffect(before, before, { kind: "syncHedge" }).ok).toBe(false);
  });

  it("accepts a liquidation that adds inventory and sends a hedge", () => {
    const before = makeState();
    const after = makeState({ inventory: NVDAX(9), pendingHedge: readyPending() });

    expect(verifyEffect(before, after, liquidation).ok).toBe(true);
  });

  it("rejects a liquidation with no inventory change", () => {
    const before = makeState();
    const after = makeState({ pendingHedge: readyPending() });

    expect(verifyEffect(before, after, liquidation).ok).toBe(false);
  });

  it("accepts an unwind that reduces inventory", () => {
    const before = makeState({ inventory: NVDAX(10) });
    const after = makeState({ inventory: NVDAX(9) });

    expect(verifyEffect(before, after, { kind: "unwindStep" }).ok).toBe(true);
    expect(verifyEffect(after, before, { kind: "unwindStep" }).ok).toBe(false);
  });

  it("checks a top-up on the EVM side, where it lands in the same block", () => {
    const before = makeState({ idleUsdc: USDC(1000) });
    const after = makeState({ idleUsdc: USDC(900) });

    expect(verifyEffect(before, after, { kind: "topUpMargin", amount: USDC(100) }).ok).toBe(true);
    expect(verifyEffect(before, before, { kind: "topUpMargin", amount: USDC(100) }).ok).toBe(false);
  });

  it("accepts a withdrawal whose Core debit hasn't landed yet", () => {
    const state = makeState({ coreUsdc: USDC(500) });

    expect(verifyEffect(state, state, { kind: "withdrawMargin", amount: USDC(90) }).ok).toBe(true);
  });
});
