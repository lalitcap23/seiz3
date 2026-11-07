import { describe, expect, it } from "vitest";

import { buildReports } from "../../src/riskCalc.js";
import {
  RiskEngineProtocolError,
  buildRiskRequest,
  parseRiskDecision,
  parseRiskRequest,
  serializeRiskRequest,
  stateFromRiskRequest,
} from "../../src/riskEngine.js";
import type { ScanReport } from "../../src/types.js";
import {
  BORROWER_A,
  BORROWER_A_MAX_SEIZE,
  NOW,
  OTHER_MARKET_ID,
  USDC,
  NVDAX,
  liquidatableBorrower,
  makeConfig,
  makeState,
} from "./fixtures.js";

const cfg = makeConfig();

function scanFor(state = makeState({ borrowers: [liquidatableBorrower()] })): ScanReport {
  const reports = buildReports(state);
  return {
    ts: NOW,
    blockNumber: state.blockNumber,
    morpho: cfg.morpho,
    marketId: state.market.id,
    price: state.market.price,
    lltv: state.market.lltv,
    borrowers: reports,
    liquidatableCount: reports.filter((b) => b.liquidatable).length,
  };
}

describe("riskEngine: request builder", () => {
  it("exports the full state plus computed borrower values", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });
    const scan = scanFor(state);
    const request = buildRiskRequest(state, scan, NOW, cfg);

    expect(request.blockNumber).toBe(1000n);
    expect(request.vault).toBe(cfg.vault);
    expect(request.morpho).toBe(cfg.morpho);
    expect(request.keeper.now).toBe(NOW);
    expect(request.state.borrowers[0]).toMatchObject({
      address: BORROWER_A,
      liquidatable: true,
      ltvBps: 9000n,
      maxSeizedAssets: BORROWER_A_MAX_SEIZE,
    });
  });

  it("serializes every bigint as a decimal string", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });
    const json = serializeRiskRequest(buildRiskRequest(state, scanFor(state), NOW, cfg));

    expect(json).not.toContain("n,");
    expect(json).not.toContain("n}");
    const parsed = JSON.parse(json) as { blockNumber: string; state: { inventory: string } };
    expect(parsed.blockNumber).toBe("1000");
    expect(parsed.state.inventory).toBe("0");
  });

  it("round-trips through parseRiskRequest", () => {
    const state = makeState({
      inventory: NVDAX(3),
      confirmedShort: -3000n,
      pauseFlags: 2n,
      coreUsdc: USDC(500),
      marginShortfall: USDC(25),
      borrowers: [liquidatableBorrower()],
    });
    const original = buildRiskRequest(state, scanFor(state), NOW, cfg);
    const parsed = parseRiskRequest(JSON.parse(serializeRiskRequest(original)));

    expect(parsed).toEqual(original);
  });

  it("rebuilds a VaultState for the reference engine", () => {
    const state = makeState({ borrowers: [liquidatableBorrower()] });
    const request = buildRiskRequest(state, scanFor(state), NOW, cfg);
    const rebuilt = stateFromRiskRequest(request);

    expect(rebuilt.borrowers[0]).toEqual({
      address: BORROWER_A,
      collateral: state.borrowers[0]?.collateral,
      borrowAssets: state.borrowers[0]?.borrowAssets,
    });
    expect(rebuilt.blockNumber).toBe(state.blockNumber);
    expect(rebuilt.blockTimestamp).toBe(NOW);
  });

  it("rejects a malformed request", () => {
    expect(() => parseRiskRequest({ blockNumber: "1" })).toThrow(RiskEngineProtocolError);
  });
});

describe("riskEngine: decision parser", () => {
  it("accepts a null action", () => {
    expect(parseRiskDecision({ action: null, reason: "idle" })).toEqual({
      action: null,
      reason: "idle",
    });
  });

  it("parses a liquidate action with string integers", () => {
    const decision = parseRiskDecision({
      action: {
        kind: "liquidate",
        marketId: `0x${"11".repeat(32)}`,
        borrower: BORROWER_A,
        seizedAssets: "10000000000000000000",
      },
      reason: "liquidate-ready",
      confidenceBps: "9500",
      engineVersion: "test-1",
    });

    expect(decision).toEqual({
      action: {
        kind: "liquidate",
        marketId: `0x${"11".repeat(32)}`,
        borrower: BORROWER_A,
        seizedAssets: NVDAX(10),
      },
      reason: "liquidate-ready",
      confidenceBps: 9500n,
      engineVersion: "test-1",
    });
  });

  it("parses a syncHedge action", () => {
    expect(parseRiskDecision({ action: { kind: "syncHedge" }, reason: "sync-ready" }).action).toEqual({
      kind: "syncHedge",
    });
  });

  it("rejects unknown action kinds, the retired margin moves included", () => {
    expect(() =>
      parseRiskDecision({ action: { kind: "dumpEverything" }, reason: "bad" }),
    ).toThrow(RiskEngineProtocolError);
    expect(() =>
      parseRiskDecision({ action: { kind: "topUpMargin", amount: "1000000" }, reason: "topup" }),
    ).toThrow(/unknown action kind/);
  });

  it("rejects a bad borrower address", () => {
    expect(() =>
      parseRiskDecision({
        action: {
          kind: "liquidate",
          marketId: `0x${"11".repeat(32)}`,
          borrower: "0x1234",
          seizedAssets: "1",
        },
        reason: "bad",
      }),
    ).toThrow(/20-byte hex address/);
  });

  it("rejects a non-integer amount", () => {
    expect(() =>
      parseRiskDecision({
        action: { kind: "liquidate", marketId: `0x${"11".repeat(32)}`, borrower: BORROWER_A, seizedAssets: "1.5" },
        reason: "bad",
      }),
    ).toThrow(/integer string/);
  });

  it("rejects a missing reason", () => {
    expect(() => parseRiskDecision({ action: null })).toThrow(/reason/);
  });

  it("rejects a decision that is not an object", () => {
    expect(() => parseRiskDecision("idle")).toThrow(/object/);
  });

  it("does not care about an unrelated market id in a null decision", () => {
    expect(parseRiskDecision({ action: null, reason: "idle" }).action).toBeNull();
    expect(OTHER_MARKET_ID).toHaveLength(66);
  });
});
