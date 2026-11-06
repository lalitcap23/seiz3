import { describe, expect, it } from "vitest";

import { PAUSE_HEDGE, PAUSE_MARGIN, PAUSE_OWNER, guards } from "../../src/riskCalc.js";
import type { Action } from "../../src/types.js";
import {
  BORROWER_A,
  BORROWER_A_MAX_SEIZE,
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
  seizedAssets: overrides.seizedAssets ?? BORROWER_A_MAX_SEIZE,
});
const unwindAction: Action = { kind: "unwindStep" };
const withdrawAction = (amount = USDC(90)): Action => ({ kind: "withdrawMargin", amount });

describe("guards: syncHedge", () => {
  it("accepts a ready pending hedge", () => {
    const state = makeState({ pendingHedge: readyPending() });

    expect(guards(syncAction, state, NOW, cfg)).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects when nothing is pending and nothing is paused", () => {
    expect(guards(syncAction, makeState(), NOW, cfg)).toEqual({ ok: false, reason: "no-pending-hedge" });
  });

  it("accepts a sync with nothing pending when it can clear a hedge or margin pause", () => {
    expect(guards(syncAction, makeState({ pauseFlags: PAUSE_MARGIN }), NOW, cfg).ok).toBe(true);
    expect(guards(syncAction, makeState({ pauseFlags: PAUSE_HEDGE }), NOW, cfg).ok).toBe(true);
    expect(guards(syncAction, makeState({ pauseFlags: PAUSE_OWNER }), NOW, cfg)).toEqual({
      ok: false,
      reason: "no-pending-hedge",
    });
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

  it("is allowed under an owner pause", () => {
    const state = makeState({ pauseFlags: PAUSE_OWNER, pendingHedge: readyPending() });

    expect(guards(syncAction, state, NOW, cfg).ok).toBe(true);
  });
});

describe("guards: pauses and pending hedges, as the vault applies them", () => {
  it("liquidate refuses any pause and any pending hedge", () => {
    const borrowers = [liquidatableBorrower()];
    for (const pauseFlags of [PAUSE_HEDGE, PAUSE_MARGIN, PAUSE_OWNER]) {
      expect(guards(liquidateAction(), makeState({ pauseFlags, borrowers }), NOW, cfg)).toEqual({
        ok: false,
        reason: "vault-paused",
      });
    }
    expect(
      guards(liquidateAction(), makeState({ pendingHedge: readyPending(), borrowers }), NOW, cfg),
    ).toEqual({ ok: false, reason: "hedge-pending" });
  });

  it("unwindStep refuses only an owner pause, plus any pending hedge", () => {
    const inventory = NVDAX(10);
    expect(guards(unwindAction, makeState({ inventory, pauseFlags: PAUSE_MARGIN }), NOW, cfg).ok).toBe(true);
    expect(guards(unwindAction, makeState({ inventory, pauseFlags: PAUSE_OWNER }), NOW, cfg)).toEqual({
      ok: false,
      reason: "vault-paused",
    });
    expect(
      guards(unwindAction, makeState({ inventory, pendingHedge: readyPending() }), NOW, cfg),
    ).toEqual({ ok: false, reason: "hedge-pending" });
  });

  it("topUpMargin goes through pauses and pending hedges", () => {
    const state = makeState({
      marginShortfall: USDC(1000),
      pauseFlags: PAUSE_MARGIN | PAUSE_OWNER,
      pendingHedge: readyPending(),
    });

    expect(guards(topUpAction(), state, NOW, cfg).ok).toBe(true);
  });

  it("withdrawMargin refuses a pending hedge", () => {
    const state = makeState({ coreUsdc: USDC(500), pendingHedge: readyPending() });

    expect(guards(withdrawAction(), state, NOW, cfg)).toEqual({ ok: false, reason: "hedge-pending" });
  });
});

describe("guards: topUpMargin", () => {
  it("accepts up to the shortfall plus 10% within idle funds", () => {
    const state = makeState({ marginShortfall: USDC(1000) });

    expect(guards(topUpAction(USDC(1100)), state, NOW, cfg).ok).toBe(true);
  });

  it("rejects without a shortfall", () => {
    expect(guards(topUpAction(), makeState(), NOW, cfg)).toEqual({
      ok: false,
      reason: "no-margin-shortfall",
    });
  });

  it("rejects more than the shortfall plus 10%", () => {
    const state = makeState({ marginShortfall: USDC(1000) });

    expect(guards(topUpAction(USDC(1101)), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "topup-above-shortfall",
    });
  });

  it("rejects a zero amount", () => {
    const state = makeState({ marginShortfall: USDC(1000) });

    expect(guards(topUpAction(0n), state, NOW, cfg)).toEqual({ ok: false, reason: "amount-zero" });
  });

  it("rejects an amount above idle USDC minus reserve", () => {
    const state = makeState({ marginShortfall: USDC(1000), idleUsdc: USDC(50) });

    expect(guards(topUpAction(USDC(41)), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "insufficient-idle",
    });
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

  it("rejects a notional above the band-shaved maxLiquidation", () => {
    const whale = { address: BORROWER_A, collateral: NVDAX(100), borrowAssets: USDC(90_000) };
    const state = makeState({ borrowers: [whale] });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(10) }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-max-liquidation",
    });
    expect(guards(liquidateAction({ seizedAssets: 9_849_000_000_000_000_000n }), state, NOW, cfg).ok).toBe(
      true,
    );
  });

  it("rejects seizing all the collateral when the bonus would repay more than the debt", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()], risk: { maxLiquidation: USDC(10_000) } });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(10) }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-debt",
    });
    expect(guards(liquidateAction({ seizedAssets: BORROWER_A_MAX_SEIZE + 1n }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-debt",
    });
  });

  it("rejects a repayment the vault's idle USDC can't cover", () => {
    const state = makeState({ idleUsdc: USDC(600), borrowers: [liquidatableBorrower()] });

    expect(guards(liquidateAction({ seizedAssets: NVDAX(2) }), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "size-exceeds-cash",
    });
  });
});

describe("guards: unwindStep", () => {
  it("accepts a due unwind", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: NOW - 30n });

    expect(guards(unwindAction, state, NOW, cfg).ok).toBe(true);
  });

  it("rejects with no inventory", () => {
    expect(guards(unwindAction, makeState({ inventory: 0n }), NOW, cfg)).toEqual({
      ok: false,
      reason: "no-inventory",
    });
  });

  it("rejects during cooldown", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: NOW - 29n });

    expect(guards(unwindAction, state, NOW, cfg)).toEqual({ ok: false, reason: "cooldown-active" });
  });
});

describe("guards: withdrawMargin", () => {
  it("accepts the whole excess over marginTarget plus reserve", () => {
    const state = makeState({ coreUsdc: USDC(500) });

    expect(guards(withdrawAction(USDC(90)), state, NOW, cfg).ok).toBe(true);
  });

  it("rejects while inventory remains", () => {
    const state = makeState({ inventory: NVDAX(1), coreUsdc: USDC(500) });

    expect(guards(withdrawAction(), state, NOW, cfg)).toEqual({ ok: false, reason: "position-open" });
  });

  it("rejects while the short is still open", () => {
    const state = makeState({ confirmedShort: -10_000n, coreUsdc: USDC(500) });

    expect(guards(withdrawAction(), state, NOW, cfg)).toEqual({ ok: false, reason: "position-open" });
  });

  it("rejects a zero amount", () => {
    const state = makeState({ coreUsdc: USDC(500) });

    expect(guards(withdrawAction(0n), state, NOW, cfg)).toEqual({ ok: false, reason: "amount-zero" });
  });

  it("rejects dipping into the margin the next liquidation needs", () => {
    const state = makeState({ coreUsdc: USDC(500) });

    expect(guards(withdrawAction(USDC(91)), state, NOW, cfg)).toEqual({
      ok: false,
      reason: "insufficient-core",
    });
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
