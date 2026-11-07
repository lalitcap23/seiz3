import { describe, expect, it } from "vitest";

import { PAUSE_HEDGE, PAUSE_MARGIN, PAUSE_OWNER, decide, evaluate } from "../../src/riskCalc.js";
import type { VaultState } from "../../src/types.js";
import {
  BORROWER_A,
  BORROWER_A_MAX_SEIZE,
  BORROWER_B,
  MARKET_ID,
  NOW,
  USDC,
  NVDAX,
  healthyBorrower,
  liquidatableBorrower,
  makeState,
  readyPending,
} from "./fixtures.js";

describe("decide: pending hedge retry loop", () => {
  it("returns null while the hedge was sent in the current block", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -10_000n, sentBlock: 1000n, sentAt: NOW - 100n, tries: 1n },
    });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "wait-same-block" });
    expect(decide(state, NOW)).toBeNull();
  });

  it("returns null before the order delay has elapsed", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -10_000n, sentBlock: 999n, sentAt: NOW - 4n, tries: 1n },
    });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "wait-order-delay" });
  });

  it("syncs at the exact block and delay boundary", () => {
    const state = makeState({
      blockNumber: 1000n,
      pendingHedge: { delta: -10_000n, sentBlock: 999n, sentAt: NOW - 5n, tries: 1n },
    });

    expect(decide(state, NOW)).toEqual({ kind: "syncHedge" });
  });

  it("does nothing else while a hedge is pending but not syncable", () => {
    const state = makeState({
      marginShortfall: USDC(100),
      inventory: NVDAX(10),
      borrowers: [liquidatableBorrower()],
      pendingHedge: { delta: -10_000n, sentBlock: 1000n, sentAt: NOW, tries: 1n },
    });

    expect(evaluate(state, NOW).reason).toBe("wait-same-block");
  });

  it("syncHedge wins over a margin shortfall and liquidation", () => {
    const state = makeState({
      marginShortfall: USDC(100),
      borrowers: [liquidatableBorrower()],
      pendingHedge: readyPending(),
    });

    expect(evaluate(state, NOW)).toEqual({ action: { kind: "syncHedge" }, reason: "sync-ready" });
  });

  it("keeps syncing under every kind of pause", () => {
    for (const pauseFlags of [PAUSE_HEDGE, PAUSE_MARGIN, PAUSE_OWNER]) {
      const state = makeState({ pauseFlags, pendingHedge: readyPending() });
      expect(evaluate(state, NOW).reason).toBe("sync-ready");
    }
  });
});

describe("decide: owner pause", () => {
  it("does nothing but sync", () => {
    const cases: Array<Partial<VaultState>> = [
      { marginShortfall: USDC(100) },
      { borrowers: [liquidatableBorrower()] },
      { inventory: NVDAX(10) },
      { coreUsdc: USDC(5000) },
    ];

    for (const patch of cases) {
      const state = makeState({ ...patch, pauseFlags: PAUSE_OWNER });
      expect(evaluate(state, NOW)).toEqual({ action: null, reason: "paused" });
    }
  });
});

describe("decide: hedge and margin pauses", () => {
  it("syncs to clear a margin pause once the shortfall is gone", () => {
    const state = makeState({ pauseFlags: PAUSE_MARGIN, marginShortfall: 0n });

    expect(evaluate(state, NOW)).toEqual({ action: { kind: "syncHedge" }, reason: "clear-pause" });
  });

  it("unwinds to raise cash while margin is still short", () => {
    const state = makeState({
      pauseFlags: PAUSE_MARGIN,
      marginShortfall: USDC(100),
      idleUsdc: USDC(10),
      inventory: NVDAX(10),
    });

    expect(evaluate(state, NOW)).toEqual({ action: { kind: "unwindStep" }, reason: "unwind-ready" });
  });

  it("never liquidates while paused", () => {
    const state = makeState({
      pauseFlags: PAUSE_MARGIN,
      marginShortfall: USDC(100),
      idleUsdc: USDC(10),
      borrowers: [liquidatableBorrower()],
    });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "paused" });
  });

  it("waits out a hedge pause while margin is still short", () => {
    const state = makeState({
      pauseFlags: PAUSE_HEDGE,
      marginShortfall: USDC(100),
      idleUsdc: USDC(10),
      coreUsdc: USDC(5000),
    });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "paused" });
  });
});

describe("decide: margin shortfall", () => {
  it("still liquidates while unpaused (the keeper can't top up)", () => {
    const state = makeState({
      marginShortfall: USDC(1000),
      idleUsdc: USDC(10),
      risk: { withdrawReserve: 0n },
      borrowers: [{ address: BORROWER_A, collateral: NVDAX(1), borrowAssets: USDC(95) }],
    });

    expect(evaluate(state, NOW).reason).toBe("liquidate-ready");
  });
});

describe("decide: liquidate", () => {
  it("seizes as much as Morpho will repay against the debt", () => {
    const state = makeState({ borrowers: [liquidatableBorrower(BORROWER_A)] });

    expect(evaluate(state, NOW)).toEqual({
      action: {
        kind: "liquidate",
        marketId: MARKET_ID,
        borrower: BORROWER_A,
        seizedAssets: BORROWER_A_MAX_SEIZE,
      },
      reason: "liquidate-ready",
    });
  });

  it("skips healthy borrowers", () => {
    const state = makeState({ borrowers: [healthyBorrower()] });

    expect(evaluate(state, NOW).reason).toBe("idle");
  });

  it("treats a position exactly at LLTV as healthy", () => {
    const atLltv = { address: BORROWER_A, collateral: NVDAX(10), borrowAssets: USDC(800) };
    const state = makeState({ borrowers: [atLltv] });

    expect(decide(state, NOW)).toBeNull();
  });

  it("picks the first liquidatable borrower in list order", () => {
    const state = makeState({ borrowers: [healthyBorrower(), liquidatableBorrower(BORROWER_A)] });

    expect(evaluate(state, NOW).action).toMatchObject({ kind: "liquidate", borrower: BORROWER_A });
  });

  it("caps the notional at maxLiquidation, shaved by the oracle band", () => {
    const whale = { address: BORROWER_A, collateral: NVDAX(100), borrowAssets: USDC(90_000) };
    const state = makeState({ borrowers: [whale] });

    // 1000 USDC × (1 − 1.51%) at $100
    expect(decide(state, NOW)).toMatchObject({ seizedAssets: 9_849_000_000_000_000_000n });
  });

  it("caps seized assets at the borrower's collateral", () => {
    const deep = { address: BORROWER_A, collateral: NVDAX(1), borrowAssets: USDC(95) };
    const state = makeState({ borrowers: [deep] });

    expect(decide(state, NOW)).toMatchObject({ seizedAssets: NVDAX(1) });
  });

  it("caps the repayment at idle USDC above the vault's withdraw reserve", () => {
    const state = makeState({ idleUsdc: USDC(502), borrowers: [liquidatableBorrower()] });

    // 2 USDC spare − 2 units of rounding, × LIF, at $100
    expect(decide(state, NOW)).toMatchObject({ seizedAssets: 21_276_570_000_000_000n });
  });

  it("moves on to the next borrower when one can't be sized", () => {
    // worth 0 USDC, owes 1 unit: under water, but nothing to repay against
    const dust = { address: BORROWER_B, collateral: 1n, borrowAssets: 1n };
    const state = makeState({ borrowers: [dust, liquidatableBorrower(BORROWER_A)] });

    expect(evaluate(state, NOW).action).toMatchObject({ borrower: BORROWER_A });
  });

  it("does not liquidate when the oracle price is invalid", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()], market: { price: 0n } });

    expect(evaluate(state, NOW).action).toBeNull();
  });

  it("does not liquidate when the per-action cap is zero", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()], risk: { maxLiquidation: 0n } });

    expect(evaluate(state, NOW).action).toBeNull();
  });

  it("liquidates before unwinding existing inventory", () => {
    const state = makeState({ inventory: NVDAX(5), borrowers: [liquidatableBorrower()] });

    expect(evaluate(state, NOW).reason).toBe("liquidate-ready");
  });
});

describe("decide: unwindStep", () => {
  it("unwinds immediately when the vault has never unwound", () => {
    const state = makeState({ inventory: NVDAX(10), lastUnwindAt: 0n });

    expect(evaluate(state, NOW)).toEqual({ action: { kind: "unwindStep" }, reason: "unwind-ready" });
  });

  it("unwinds at the open-market cooldown boundary", () => {
    const state = makeState({ inventory: NVDAX(10), marketOpen: true, lastUnwindAt: NOW - 30n });

    expect(decide(state, NOW)).toEqual({ kind: "unwindStep" });
  });

  it("waits out the open-market cooldown", () => {
    const state = makeState({ inventory: NVDAX(10), marketOpen: true, lastUnwindAt: NOW - 29n });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "unwind-cooldown" });
  });

  it("uses the closed-market cooldown from RiskParams when the market is closed", () => {
    const cooling = makeState({ inventory: NVDAX(10), marketOpen: false, lastUnwindAt: NOW - 100n });
    expect(evaluate(cooling, NOW).reason).toBe("unwind-cooldown");

    const ready = makeState({ inventory: NVDAX(10), marketOpen: false, lastUnwindAt: NOW - 300n });
    expect(decide(ready, NOW)).toEqual({ kind: "unwindStep" });
  });
});

describe("decide: no stock left", () => {
  it("reports a short that is still open", () => {
    const state = makeState({ confirmedShort: -10_000n, coreUsdc: USDC(5000) });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "position-open" });
  });

  it("is idle with nothing on Core", () => {
    const state = makeState({ coreUsdc: 0n, marginTarget: 0n });

    expect(evaluate(state, NOW)).toEqual({ action: null, reason: "idle" });
  });
});

describe("decide: priority order", () => {
  const cases: Array<{
    name: string;
    state: VaultState;
    expected: string;
  }> = [
    {
      name: "sync > liquidate > unwind",
      state: makeState({
        pendingHedge: readyPending(),
        marginShortfall: USDC(100),
        borrowers: [liquidatableBorrower()],
        inventory: NVDAX(10),
        coreUsdc: USDC(5000),
      }),
      expected: "sync-ready",
    },
    {
      name: "liquidate > unwind",
      state: makeState({ borrowers: [liquidatableBorrower()], inventory: NVDAX(10) }),
      expected: "liquidate-ready",
    },
  ];

  it.each(cases)("$name", ({ state, expected }) => {
    expect(evaluate(state, NOW).reason).toBe(expected);
  });

  it("decide() returns exactly evaluate().action", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });

    expect(decide(state, NOW)).toEqual(evaluate(state, NOW).action);
  });
});
