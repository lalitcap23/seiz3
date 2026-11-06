import { describe, expect, it } from "vitest";

import { borrowerReport, buildReports, mergeCandidates } from "../../src/riskCalc.js";
import {
  BORROWER_A,
  BORROWER_B,
  USDC,
  NVDAX,
  healthyBorrower,
  liquidatableBorrower,
  makeConfig,
  makeState,
} from "./fixtures.js";

const cfg = makeConfig();

describe("borrowers: candidate merge", () => {
  it("puts deployed borrowers first and deduplicates", () => {
    const deployed = [
      { address: BORROWER_A, collateral: NVDAX(1), borrowAssets: USDC(1), label: "first" },
    ];
    const onchain = [BORROWER_A, BORROWER_B];

    expect(mergeCandidates(deployed, onchain)).toEqual([
      { address: BORROWER_A, label: "first" },
      { address: BORROWER_B },
    ]);
  });

  it("deduplicates case-insensitively", () => {
    const deployed = [
      { address: "0x00000000000000000000000000000000000000aB" as const, collateral: 0n, borrowAssets: 0n },
    ];
    const onchain = ["0x00000000000000000000000000000000000000AB" as const];

    expect(mergeCandidates(deployed, onchain)).toHaveLength(1);
  });
});

describe("borrowers: report values", () => {
  it("computes LTV, LLTV bps, value and max seize", () => {
    const state = makeState();
    const report = borrowerReport(liquidatableBorrower(), state.market, state.risk);

    expect(report).toMatchObject({
      address: BORROWER_A,
      collateralValueUsdc: USDC(1000),
      ltvBps: 9000n,
      lltvBps: 8000n,
      liquidatable: true,
      maxSeizedAssets: NVDAX(10),
    });
  });

  it("marks healthy positions as not liquidatable", () => {
    const state = makeState();
    const report = borrowerReport(healthyBorrower(), state.market, state.risk);

    expect(report.liquidatable).toBe(false);
    expect(report.ltvBps).toBe(7000n);
  });

  it("uses zero LTV when collateral value is zero", () => {
    const state = makeState({ market: { price: 0n } });
    const report = borrowerReport(liquidatableBorrower(), state.market, state.risk);

    expect(report.ltvBps).toBe(0n);
    expect(report.liquidatable).toBe(false);
  });

  it("attaches labels from deployments", () => {
    const state = makeState({ borrowers: [liquidatableBorrower(), healthyBorrower()] });
    const labels = new Map([
      [BORROWER_A.toLowerCase(), "liquidatable"],
      [BORROWER_B.toLowerCase(), "healthy"],
    ]);

    const reports = buildReports(state.borrowers, state.market, state.risk, labels);

    expect(reports[0]?.label).toBe("liquidatable");
    expect(reports[1]?.label).toBe("healthy");
    expect(cfg.deployments.borrowers).toHaveLength(2);
  });
});
