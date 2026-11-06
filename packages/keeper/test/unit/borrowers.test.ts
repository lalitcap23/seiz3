import { describe, expect, it } from "vitest";

import {
  borrowAssetsOf,
  borrowerReport,
  buildReports,
  liquidationIncentiveFactor,
  mergeCandidates,
} from "../../src/riskCalc.js";
import {
  BORROWER_A,
  BORROWER_A_MAX_SEIZE,
  BORROWER_B,
  USDC,
  healthyBorrower,
  liquidatableBorrower,
  makeConfig,
  makeState,
} from "./fixtures.js";

const cfg = makeConfig();

describe("borrowers: candidate merge", () => {
  it("puts deployed borrowers first and deduplicates", () => {
    const deployed = [{ address: BORROWER_A, label: "first" }];
    const extra = [BORROWER_A, BORROWER_B];

    expect(mergeCandidates(deployed, extra)).toEqual([
      { address: BORROWER_A, label: "first" },
      { address: BORROWER_B },
    ]);
  });

  it("deduplicates case-insensitively", () => {
    const deployed = [{ address: "0x00000000000000000000000000000000000000aB" as const }];
    const extra = ["0x00000000000000000000000000000000000000AB" as const];

    expect(mergeCandidates(deployed, extra)).toHaveLength(1);
  });
});

describe("borrowers: Morpho math", () => {
  it("converts debt shares to assets rounding up, with Morpho's virtual shares", () => {
    // a fresh market: 1 asset ≈ 1e6 shares
    expect(borrowAssetsOf(900n * 10n ** 12n, 0n, 0n)).toBe(USDC(900));
    expect(borrowAssetsOf(1n, USDC(900), 900n * 10n ** 12n)).toBe(1n);
    expect(borrowAssetsOf(0n, USDC(900), 900n * 10n ** 12n)).toBe(0n);
  });

  it("matches Morpho's liquidation incentive", () => {
    expect(liquidationIncentiveFactor(77n * 10n ** 16n)).toBe(1_074_113_856_068_743_286n); // ≈ 7.4% bonus
    expect(liquidationIncentiveFactor(10n ** 16n)).toBe(115n * 10n ** 16n); // capped at 15%
  });
});

describe("borrowers: report values", () => {
  it("computes LTV, LLTV bps, value and max seize", () => {
    const report = borrowerReport(liquidatableBorrower(), makeState());

    expect(report).toMatchObject({
      address: BORROWER_A,
      collateralValueUsdc: USDC(1000),
      ltvBps: 9000n,
      lltvBps: 8000n,
      liquidatable: true,
      maxSeizedAssets: BORROWER_A_MAX_SEIZE,
    });
  });

  it("marks healthy positions as not liquidatable", () => {
    const report = borrowerReport(healthyBorrower(), makeState());

    expect(report.liquidatable).toBe(false);
    expect(report.ltvBps).toBe(7000n);
  });

  it("uses zero LTV when collateral value is zero", () => {
    const report = borrowerReport(liquidatableBorrower(), makeState({ market: { price: 0n } }));

    expect(report.ltvBps).toBe(0n);
    expect(report.liquidatable).toBe(false);
  });

  it("attaches labels from deployments", () => {
    const state = makeState({ borrowers: [liquidatableBorrower(), healthyBorrower()] });
    const labels = new Map([
      [BORROWER_A.toLowerCase(), "liquidatable"],
      [BORROWER_B.toLowerCase(), "healthy"],
    ]);

    const reports = buildReports(state, labels);

    expect(reports[0]?.label).toBe("liquidatable");
    expect(reports[1]?.label).toBe("healthy");
    expect(cfg.deployments.borrowers).toHaveLength(2);
  });
});
