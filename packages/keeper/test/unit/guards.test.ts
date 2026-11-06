import { describe, expect, it } from "vitest";

import { guards } from "../../src/riskCalc.js";
import type { Action } from "../../src/types.js";
import {
  BORROWER_A,
  MORPHO,
  NOW,
  OTHER_MARKET_ID,
  USDC,
  NVDAX,
  healthyBorrower,
  liquidatableBorrower,
  makeConfig,
  makeState,
  readyPending,
} from "./fixtures.js";

const cfg = makeConfig();

const syncAction: Action = { kind: "syncHedge" };
const topUpAction = (amount = USDC(1000)): Action => ({ kind: "topUpMargin", amount });
const liquidateAction = (overrides: Partial<Extract<Action, { kind: "liquidate" }>> = {}): Action => ({
  kind: "liquidate",
  marketId: (overrides.marketId ?? makeState().market.id) as `0x${string}`,
  borrower: overrides.borrower ?? BORROWER_A,
  seizedAssets: overrides.seizedAssets ?? NVDAX(10),
});
const unwindAction: Action = { kind: "unwindStep" };
const withdrawAction = (amount = USDC(90)): Action => ({ kind: "withdrawMargin", amount });

describe("guards: syncHedge", () => {
  it("accepts a ready pending hedge", () => {
    const state = makeState({ pendingHedge: readyPending() });

    expect(guards(syncAction, state, NOW, cfg)).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects when nothing is pending", () => {
    expect(guards(syncAction, makeState(), NOW, cfg)).toEqual({ ok: false, reason: "no-pending-hedge" });
  });

  it("rejects in the same block even when the delay elapsed", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -1n, sentBlock: 1000n, sentAt: NOW - 100n, tries: 1n },
    });

    expect(guards(syncAction, state, NOW, cfg)).toEqual({ ok: false, reason: "same-block" });
  });

  it("rejects before the order delay", () => {
    const state = makeState({ pendingHedge: readyPending({ sentAt: NOW - 4n }) });

    expect(guards(syncAction, state, NOW, cfg)).toEqual({ ok: false, reason: "order-delay" });
  });

  it("accepts at the exact delay boundary", () => {
    const state = makeState({ pendingHedge: readyPending({ sentAt: NOW - 5n }) });

    expect(guards(syncAction, state, NOW, cfg).ok).toBe(true);
  });

  it("is the only action allowed while paused", () => {
    const state = makeState({ paused: true, pendingHedge: readyPending() });

    expect(guards(syncAction, state, NOW, cfg).ok).toBe(true);
  });
});

describe("guards: paused and pending blockers", () => {
  it("rejects every non-sync action while paused", () => {
    const state = makeState({ paused: true, borrowers: [liquidatableBorrower()] });

    for (const action of [
      topUpAction(),
      liquidateAction(),
      unwindAction,
      withdrawAction(),
    ]) {
      expect(guards(action, state, NOW, cfg)).toEqual({ ok: false, reason: "vault-paused" });
    }
  });

  it("rejects every non-sync action while a hedge is pending", () => {
    const state = makeState({ pendingHedge: readyPending(), borrowers: [liquidatableBorrower()] });

    for (const action of [topUpAction(), liquidateAction(), unwindAction, withdrawAction()]) {
      expect(guards(action, state, NOW, cfg)).toEqual({ ok: false, reason: "hedge-pending" });
    }
  });
});

describe("guards: topUpMargin", () => {
  it("accepts a top-up below the buffer within idle funds", () => {
    const state = makeState({ marginRatioBps: 500n });

    expect(guards(topUpAction(), state, NOW, cfg).ok).toBe(true);
  });

  it("rejects when margin is at or above the buffer", () => {
    const state = makeState({ marginRatioBps: 1000n });

    expect(guards(topUpAction(), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "margin-above-buffer",
    });
  });

  it("rejects a zero amount", () => {
    const state = makeState({ marginRatioBps: 500n });

    expect(guards(topUpAction(0n), state, NOW, cfg)).toEqual({ ok: false, reason: "amount-zero" });
  });

  it("rejects an amount above idle USDC minus reserve", () => {
    const state = makeState({ marginRatioBps: 500n, idleUsdc: USDC(50) });

    expect(guards(topUpAction(USDC(41)), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "insufficient-idle",
    });
  });

  it("accepts an amount exactly at idle USDC minus reserve", () => {
    const state = makeState({ marginRatioBps: 500n, idleUsdc: USDC(50) });

    expect(guards(topUpAction(USDC(40)), state, NOW, cfg).ok).toBe(true);
  });
});

describe("guards: liquidate", () => {
  it("accepts the exact action decide picks", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction(), state, NOW, cfg).ok).toBe(true);
  });

  it("rejects a mismatched market id", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction({ marketId: OTHER_MARKET_ID }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "market-mismatch",
    });
  });

  it("rejects an unknown borrower", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });
    const stranger = "0x00000000000000000000000000000000000000ff" as const;

    expect(guards(liquidateAction({ borrower: stranger }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "unknown-borrower",
    });
  });

  it("rejects a healthy borrower", () => {
    const state = makeState({ borrowers: [healthyBorrower(BORROWER_A)] });

    expect(guards(liquidateAction(), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "borrower-healthy",
    });
  });

  it("rejects a zero seize size", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction({ seizedAssets: 0n }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "zero-size",
    });
  });

  it("rejects seizing more than the borrower's collateral", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(11) }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-collateral",
    });
  });

  it("rejects a notional above maxLiquidation", () => {
    const whale = { address: BORROWER_A, collateral: NVDAX(100), borrowAssets: USDC(90_000) };
    const state = makeState({ borrowers: [whale] });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(11) }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-max-liquidation",
    });
  });

  it("accepts a notional exactly at maxLiquidation", () => {
    const whale = { address: BORROWER_A, collateral: NVDAX(100), borrowAssets: USDC(90_000) };
    const state = makeState({ borrowers: [whale] });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(10) }), state, NOW, cfg).ok).toBe(true);
  });
});

describe("guards: unwindStep", () => {
  it("accepts a due unwind", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: NOW - 30n });

    expect(guards(unwindAction, state, NOW, cfg).ok).toBe(true);
  });

  it("rejects with no inventory", () => {
    const state = makeState({ inventory: 0n });

    expect(guards(unwindAction, state, NOW, cfg)).toEqual({ ok: false, reason: "no-inventory" });
  });

  it("rejects when the pool is outside the band", () => {
    const state = makeState({ inventory: NVDAX(10), poolPriceInBand: false });

    expect(guards(unwindAction, state, NOW, cfg)).toEqual({ ok: false, reason: "pool-out-of-band" });
  });

  it("rejects during cooldown", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: NOW - 29n });

    expect(guards(unwindAction, state, NOW, cfg)).toEqual({ ok: false, reason: "cooldown-active" });
  });
});

describe("guards: withdrawMargin", () => {
  it("accepts an amount within Core USDC minus reserve", () => {
    const state = makeState({ coreUsdc: USDC(100) });

    expect(guards(withdrawAction(), state, NOW, cfg).ok).toBe(true);
  });

  it("rejects while inventory remains", () => {
    const state = makeState({ inventory: NVDAX(1), coreUsdc: USDC(100) });

    expect(guards(withdrawAction(), state, NOW, cfg)).toEqual({ ok: false, reason: "position-open" });
  });

  it("rejects while the short is still open", () => {
    const state = makeState({ confirmedShort: -NVDAX(10), coreUsdc: USDC(100) });

    expect(guards(withdrawAction(), state, NOW, cfg)).toEqual({ ok: false, reason: "position-open" });
  });

  it("rejects a zero amount", () => {
    const state = makeState({ coreUsdc: USDC(100) });

    expect(guards(withdrawAction(0n), state, NOW, cfg)).toEqual({ ok: false, reason: "amount-zero" });
  });

  it("rejects an amount above Core USDC minus reserve", () => {
    const state = makeState({ coreUsdc: USDC(100) });

    expect(guards(withdrawAction(USDC(91)), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "insufficient-core",
    });
  });

  it("accepts the whole excess", () => {
    const state = makeState({ coreUsdc: USDC(100) });

    expect(guards(withdrawAction(USDC(90)), state, NOW, cfg).ok).toBe(true);
  });
});

describe("guards: address casing", () => {
  it("treats checksummed and lowercase addresses and market ids as equal", () => {
    const mixedBorrower = "0x00000000000000000000000000000000000000aB" as const;
    const mixedMarket = `0x${"aB".repeat(32)}` as `0x${string}`;
    const state = makeState({
      borrowers: [{ address: mixedBorrower, collateral: NVDAX(10), borrowAssets: USDC(900) }],
      market: { id: mixedMarket },
    });

    const action = liquidateAction({
      marketId: mixedMarket.toUpperCase().replace("0X", "0x") as `0x${string}`,
      borrower: mixedBorrower.toUpperCase().replace("0X", "0x") as `0x${string}`,
    });

    expect(guards(action, state, NOW, cfg).ok).toBe(true);
  });

  it("does not confuse different addresses", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction({ borrower: MORPHO }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "unknown-borrower",
    });
  });
});
