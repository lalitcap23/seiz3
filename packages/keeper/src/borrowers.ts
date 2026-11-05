import {
  collateralValueUsdc,
  isLiquidatable,
  seizedForCap,
} from "./math.js";
import type {
  Address,
  BorrowerReport,
  BorrowerState,
  DeploymentBorrower,
  MarketState,
  Risk,
} from "./types.js";
import { BPS, WAD } from "./units.js";

export interface Candidate {
  readonly address: Address;
  readonly label?: string;
}

/**
 * Fixed deployments.json candidates first, then any extra on-chain borrowers.
 * Deduplicated case-insensitively, order preserved.
 */
export function mergeCandidates(
  deployed: readonly DeploymentBorrower[],
  onchain: readonly Address[],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const b of deployed) {
    const key = b.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: b.address, ...(b.label === undefined ? {} : { label: b.label }) });
  }
  for (const address of onchain) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address });
  }
  return out;
}

export function ltvBpsOf(borrowAssets: bigint, valueUsdc: bigint): bigint {
  if (valueUsdc <= 0n) return 0n;
  return (borrowAssets * BPS) / valueUsdc;
}

export function borrowerReport(
  borrower: BorrowerState,
  market: MarketState,
  risk: Risk,
  label?: string,
): BorrowerReport {
  const value = collateralValueUsdc(borrower.collateral, market.price);
  return {
    address: borrower.address,
    collateral: borrower.collateral,
    borrowAssets: borrower.borrowAssets,
    lltv: market.lltv,
    lltvBps: (market.lltv * BPS) / WAD,
    collateralValueUsdc: value,
    ltvBps: ltvBpsOf(borrower.borrowAssets, value),
    liquidatable: isLiquidatable(borrower, market.price, market.lltv),
    maxSeizedAssets: seizedForCap(risk.maxLiquidation, market.price, borrower.collateral),
    ...(label === undefined ? {} : { label }),
  };
}

export function buildReports(
  borrowers: readonly BorrowerState[],
  market: MarketState,
  risk: Risk,
  labels: ReadonlyMap<string, string> = new Map(),
): BorrowerReport[] {
  return borrowers.map((b) => borrowerReport(b, market, risk, labels.get(b.address.toLowerCase())));
}
