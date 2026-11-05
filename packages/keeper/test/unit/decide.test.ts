import { describe, expect, it } from "vitest";

import { decide, evaluate } from "../../src/decide.js";
import type { VaultState } from "../../src/types.js";
import {
  BORROWER_A,
  BORROWER_B,
  MARKET_ID,
  NOW,
  USDC,
  NVDAX,
  healthyBorrower,
  liquidatableBorrower,
  makeConfig,
  makeState,
  readyPending,
} from "./fixtures.js";

const cfg = makeConfig();

describe("decide: pending hedge retry loop", () => {
  it("returns null while the hedge was sent in the current block", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -NVDAX(10), sentBlock: 1000n, sentAt: NOW - 100n, tries: 1n },
    });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "wait-same-block" });
    expect(decide(state, NOW, cfg)).toBeNull();
  });

  it("returns null before the order delay has elapsed", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -NVDAX(10), sentBlock: 999n, sentAt: NOW - 4n, tries: 1n },
    });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "wait-order-delay" });
  });

  it("syncs at the exact block and delay boundary", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -NVDAX(10), sentBlock: 999n, sentAt: NOW - 5n, tries: 1n },
    });

    expect(decide(state, NOW, cfg)).toEqual({ kind: "syncHedge" });
  });

  it("still waits for a later block even when the delay has elapsed", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -NVDAX(10), sentBlock: 1000n, sentAt: NOW - 100n, tries: 1n },
    });

    expect(evaluate(state, NOW, cfg).reason).toBe("wait-same-block");
  });

  it("does nothing else while a hedge is pending but not syncable", () => {
    const state = makeState({
      paused: false,
      marginRatioBps: 1n,
      inventory: NVDAX(10),
      borrowers: [liquidatableBorrower()],
      pendingHedge: { delta: -NVDAX(10), sentBlock: 1000n, sentAt: NOW, tries: 1n },
    });

    expect(evaluate(state, NOW, cfg).reason).toBe("wait-same-block");
  });

  it("syncHedge wins over margin top-up and liquidation", () => {
    const state = makeState({
      marginRatioBps: 1n,
      borrowers: [liquidatableBorrower()],
      pendingHedge: readyPending(),
    });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: { kind: "syncHedge" }, reason: "sync-ready" });
  });
});

describe("decide: paused vault", () => {
  it("returns null when paused with no pending hedge", () => {
    const state = makeState({ paused: true, borrowers: [liquidatableBorrower()] });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "paused" });
  });

  it("allows syncHedge while paused", () => {
    const state = makeState({ paused: true, pendingHedge: readyPending() });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: { kind: "syncHedge" }, reason: "sync-ready" });
  });

  it("still waits for the delay while paused", () => {
    const state = makeState({
      paused: true,
      pendingHedge: readyPending({ sentAt: NOW - 1n }),
    });

    expect(evaluate(state, NOW, cfg).reason).toBe("wait-order-delay");
  });

  it("never liquidates, tops up, unwinds or withdraws while paused", () => {
    const cases: Array<Partial<VaultState>> = [
      { marginRatioBps: 1n },
      { borrowers: [liquidatableBorrower()] },
      { inventory: NVDAX(10), lastUnwindAt: 0n },
      { coreUsdc: USDC(500) },
    ];

    for (const patch of cases) {
      const state = makeState({ ...patch, paused: true });
      expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "paused" });
    }
  });
});

describe("decide: topUpMargin", () => {
  it("tops up when margin is below the buffer, before liquidating", () => {
    const state = makeState({
      marginRatioBps: 500n,
      borrowers: [liquidatableBorrower()],
    });

    expect(evaluate(state, NOW, cfg)).toEqual({
      action: { kind: "topUpMargin", amount: USDC(1000) },
      reason: "topup-ready",
    });
  });

  it("caps the top-up at idle USDC above the reserve", () => {
    const state = makeState({ marginRatioBps: 500n, idleUsdc: USDC(50) });

    expect(decide(state, NOW, cfg)).toEqual({ kind: "topUpMargin", amount: USDC(40) });
  });

  it("falls through to liquidation when idle USDC equals the reserve", () => {
    const state = makeState({
      marginRatioBps: 500n,
      idleUsdc: USDC(10),
      borrowers: [liquidatableBorrower()],
    });

    expect(evaluate(state, NOW, cfg).reason).toBe("liquidate-ready");
  });

  it("does not top up with a zero configured top-up amount", () => {
    const state = makeState({ marginRatioBps: 500n, borrowers: [liquidatableBorrower()] });
    const zeroTopUp = makeConfig({ topUpUsdc: 0n });

    expect(evaluate(state, NOW, zeroTopUp).reason).toBe("liquidate-ready");
  });

  it("does not top up when margin is exactly at the buffer", () => {
    const state = makeState({ marginRatioBps: 1000n, borrowers: [liquidatableBorrower()] });

    expect(evaluate(state, NOW, cfg).reason).toBe("liquidate-ready");
  });
});

describe("decide: liquidate", () => {
  it("liquidates a borrower above LLTV when the vault is idle", () => {
    const state = makeState({ borrowers: [liquidatableBorrower(BORROWER_A)] });

    expect(evaluate(state, NOW, cfg)).toEqual({
      action: {
        kind: "liquidate",
        marketId: MARKET_ID,
        borrower: BORROWER_A,
        seizedAssets: NVDAX(10),
      },
      reason: "liquidate-ready",
    });
  });

  it("skips healthy borrowers", () => {
    const state = makeState({ borrowers: [healthyBorrower()] });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "idle" });
  });

  it("treats a position exactly at LLTV as healthy", () => {
    const atLltv = { address: BORROWER_A, collateral: NVDAX(10), borrowAssets: USDC(800) };
    const state = makeState({ borrowers: [atLltv] });

    expect(evaluate(state, NOW, cfg).reason).toBe("idle");
  });

  it("picks the first liquidatable borrower in list order", () => {
    const state = makeState({ borrowers: [healthyBorrower(), liquidatableBorrower(BORROWER_A)] });

    const decision = evaluate(state, NOW, cfg);
    expect(decision.action).toMatchObject({ kind: "liquidate", borrower: BORROWER_A });
  });

  it("caps seized assets at maxLiquidation", () => {
    const whale = { address: BORROWER_A, collateral: NVDAX(100), borrowAssets: USDC(90_000) };
    const state = makeState({ borrowers: [whale] });

    expect(decide(state, NOW, cfg)).toMatchObject({ seizedAssets: NVDAX(10) });
  });

  it("caps seized assets at the borrower's collateral", () => {
    const small = { address: BORROWER_A, collateral: NVDAX(1), borrowAssets: USDC(90) };
    const state = makeState({ borrowers: [small] });

    expect(decide(state, NOW, cfg)).toMatchObject({ seizedAssets: NVDAX(1) });
  });

  it("does not liquidate when the oracle price is invalid", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()], market: { price: 0n } });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "idle" });
  });

  it("does not liquidate when the per-action cap is zero", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()], risk: { maxLiquidation: 0n } });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "idle" });
  });

  it("does not liquidate a zero-collateral borrower", () => {
    const empty = { address: BORROWER_A, collateral: 0n, borrowAssets: USDC(10) };
    const state = makeState({ borrowers: [empty] });

    expect(evaluate(state, NOW, cfg).reason).toBe("idle");
  });

  it("liquidates before unwinding existing inventory", () => {
    const state = makeState({ inventory: NVDAX(5), borrowers: [liquidatableBorrower()] });

    expect(evaluate(state, NOW, cfg).reason).toBe("liquidate-ready");
  });
});

describe("decide: unwindStep", () => {
  it("unwinds immediately when the vault has never unwound", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: 0n });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: { kind: "unwindStep" }, reason: "unwind-ready" });
  });

  it("unwinds at the open-market cooldown boundary", () => {
    const state = makeState({ inventory: NVDAX(10), marketOpen: true, lastUnwindAt: NOW - 30n });

    expect(decide(state, NOW, cfg)).toEqual({ kind: "unwindStep" });
  });

  it("waits out the shorter open-market cooldown", () => {
    const state = makeState({ inventory: NVDAX(10), marketOpen: true, lastUnwindAt: NOW - 29n });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "unwind-cooldown" });
  });

  it("uses the vault cooldown when the market is closed", () => {
    const cooling = makeState({ inventory: NVDAX(10), marketOpen: false, lastUnwindAt: NOW - 100n });
    expect(evaluate(cooling, NOW, cfg).reason).toBe("unwind-cooldown");

    const ready = makeState({ inventory: NVDAX(10), marketOpen: false, lastUnwindAt: NOW - 300n });
    expect(decide(ready, NOW, cfg)).toEqual({ kind: "unwindStep" });
  });

  it("skips unwind when the pool price is outside the band", () => {
    const state = makeState({ inventory: NVDAX(10), poolPriceInBand: false });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "pool-out-of-band" });
  });

  it("does not unwind while paused", () => {
    const state = makeState({ inventory: NVDAX(10), paused: true });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "paused" });
  });

  it("ignores cooldown when inventory is zero", () => {
    const state = makeState({ inventory: 0n, lastUnwindAt: NOW - 1n, coreUsdc: USDC(50) });

    expect(evaluate(state, NOW, cfg).reason).toBe("withdraw-ready");
  });
});

describe("decide: withdrawMargin", () => {
  it("withdraws every Core USDC above the reserve when stock and short are zero", () => {
    const state = makeState({ inventory: 0n, confirmedShort: 0n, coreUsdc: USDC(100) });

    expect(evaluate(state, NOW, cfg)).toEqual({
      action: { kind: "withdrawMargin", amount: USDC(90) },
      reason: "withdraw-ready",
    });
  });

  it("does nothing when Core USDC is at the reserve", () => {
    const state = makeState({ coreUsdc: USDC(10) });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "core-at-reserve" });
  });

  it("does nothing when Core USDC is below the reserve", () => {
    const state = makeState({ coreUsdc: USDC(5) });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "core-at-reserve" });
  });

  it("does not withdraw while a short position remains", () => {
    const state = makeState({ confirmedShort: -NVDAX(10), coreUsdc: USDC(100) });

    expect(evaluate(state, NOW, cfg)).toEqual({ action: null, reason: "position-open" });
  });

  it("does not withdraw while inventory remains", () => {
    const state = makeState({ inventory: NVDAX(1), coreUsdc: USDC(100) });

    expect(evaluate(state, NOW, cfg).reason).toBe("unwind-ready");
  });
});

describe("decide: priority order", () => {
  const cases: Array<{
    name: string;
    state: VaultState;
    expected: string;
  }> = [
    {
      name: "sync > topup > liquidate > unwind > withdraw",
      state: makeState({
        pendingHedge: readyPending(),
        marginRatioBps: 1n,
        borrowers: [liquidatableBorrower()],
        inventory: NVDAX(10),
        coreUsdc: USDC(100),
      }),
      expected: "sync-ready",
    },
    {
      name: "topup > liquidate",
      state: makeState({ marginRatioBps: 1n, borrowers: [liquidatableBorrower()] }),
      expected: "topup-ready",
    },
    {
      name: "liquidate > unwind",
      state: makeState({ borrowers: [liquidatableBorrower()], inventory: NVDAX(10) }),
      expected: "liquidate-ready",
    },
    {
      name: "unwind > withdraw",
      state: makeState({ inventory: NVDAX(10), coreUsdc: USDC(100) }),
      expected: "unwind-ready",
    },
  ];

  it.each(cases)("$name", ({ state, expected }) => {
    expect(evaluate(state, NOW, cfg).reason).toBe(expected);
  });

  it("decide() returns exactly evaluate().action", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(decide(state, NOW, cfg)).toEqual(evaluate(state, NOW, cfg).action);
  });
});
