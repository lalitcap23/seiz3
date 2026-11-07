/**
 * riskCalc.ts — all pure keeper-side risk calculation in one place.
 *
 * Units: USDC 6 dec, NVDAx 18 dec, WAD 1e18, BPS 10_000.
 * No clock access, no network, no floating point. bigint only.
 *
 * Sections:
 *   - units      decimal parse/format helpers
 *   - math       Morpho health/size math, mirrored from Morpho Blue and Seiz3VaultRemote
 *   - reports    borrower report rows for logs + the risk engine
 *   - decide     picks AT MOST ONE action per tick
 *   - guards     per-action preconditions, checked right before simulating
 *
 * `decide(state, now) -> Action | null` priority order (first match wins):
 *   1. syncHedge      pending delta != 0, later block, order delay elapsed
 *   2. syncHedge      paused for hedge/margin, nothing pending, no shortfall: only a sync clears it
 *   3. liquidate      not paused, borrower LTV > LLTV
 *   4. unwindStep     inventory > 0, cooldown elapsed (also under a margin pause: it raises cash)
 *
 * Extra rules:
 *   - owner pause => syncHedge (when pending) is the ONLY possible action.
 *   - pending but not yet syncable => null. Nothing else runs in that tick.
 *   - `now` is the block timestamp the state was read at: the contract's clock.
 *   - Checks the keeper can't see from the EVM (pool vs Core price band, Core margin for a new
 *     short) are left to the eth_call simulation. A reverting simulation is skipped, never sent.
 *   - The keeper never signs HyperCore orders. The vault queues them at the HyperCoreGateway and
 *     the relayer places them.
 *   - The keeper never moves margin: there is no USDC bridge from Base to HyperCore, so the hedge
 *     account is funded on HyperCore (the vault's topUpMargin / withdrawMargin revert NoBridge).
 */

import type {
  Action,
  Address,
  BorrowerReport,
  BorrowerState,
  Decision,
  DeploymentBorrower,
  GuardResult,
  Hex,
  VaultState,
} from "./types.js";

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

export const USDC_DECIMALS = 6;
export const NVDAX_DECIMALS = 18;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export function parseDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal: "${value}"`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = body.split(".");
  if (fraction.length > decimals) {
    throw new Error(`too many decimals for ${decimals}-dec value: "${value}"`);
  }
  const padded = fraction.padEnd(decimals, "0");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return negative ? -result : result;
}

export function parseUsdc(value: string): bigint {
  return parseDecimal(value, USDC_DECIMALS);
}

export function parseNvdax(value: string): bigint {
  return parseDecimal(value, NVDAX_DECIMALS);
}

export function formatDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function formatUsdc(value: bigint): string {
  return formatDecimal(value, USDC_DECIMALS);
}

export function formatNvdax(value: bigint): string {
  return formatDecimal(value, NVDAX_DECIMALS);
}

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

export const MORPHO_PRICE_SCALE = 10n ** 36n;

// Morpho Blue ConstantsLib / SharesMathLib
const LIQUIDATION_CURSOR = 3n * 10n ** 17n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

// Seiz3VaultRemote pause flags
export const PAUSE_HEDGE = 1n;
export const PAUSE_MARGIN = 2n;
export const PAUSE_OWNER = 4n;

/** USDC 6-dec value of `collateral` (18 dec) at a Morpho 1e36 price. */
export function collateralValueUsdc(collateral: bigint, price: bigint): bigint {
  if (collateral <= 0n || price <= 0n) return 0n;
  return (collateral * price) / MORPHO_PRICE_SCALE;
}

/** Morpho MathLib `wTaylorCompounded`: e^(rate × elapsed) − 1 to three terms, WAD. */
export function wTaylorCompounded(rate: bigint, elapsed: bigint): bigint {
  const first = rate * elapsed;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

/**
 * Morpho `_accrueInterest` on totalBorrowAssets: the debt the next liquidation will see. The stored total only moves
 * when someone touches the market, so a loan opened just under the LLTV crosses it without any transaction.
 */
export function accruedBorrowAssets(totalBorrowAssets: bigint, borrowRate: bigint, elapsed: bigint): bigint {
  if (borrowRate <= 0n || elapsed <= 0n) return totalBorrowAssets;
  return totalBorrowAssets + (totalBorrowAssets * wTaylorCompounded(borrowRate, elapsed)) / WAD;
}

/** Morpho `toAssetsUp`: what `shares` of debt are worth, rounded against the borrower. */
export function borrowAssetsOf(
  shares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
): bigint {
  if (shares <= 0n) return 0n;
  const numerator = shares * (totalBorrowAssets + VIRTUAL_ASSETS);
  const denominator = totalBorrowShares + VIRTUAL_SHARES;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Morpho convention from the spec: liquidatable when
 * `collateral * price / 1e36 * LLTV < borrowAssets`.
 *
 * Invalid market data (price <= 0 or lltv <= 0) is treated as not liquidatable:
 * the keeper must never size a trade from a broken oracle.
 */
export function isLiquidatable(
  borrower: BorrowerState,
  price: bigint,
  lltv: bigint,
): boolean {
  if (price <= 0n || lltv <= 0n || borrower.collateral <= 0n) return false;
  const valueUsdc = collateralValueUsdc(borrower.collateral, price);
  const maxBorrow = (valueUsdc * lltv) / WAD;
  return maxBorrow < borrower.borrowAssets;
}

/** Morpho's bonus: min(1.15, 1 / (1 − 0.3 × (1 − LLTV))), WAD. About 1.074 at 77% LLTV. */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  if (lltv <= 0n || lltv > WAD) return WAD;
  const factor = (WAD * WAD) / (WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD);
  return factor < MAX_LIQUIDATION_INCENTIVE_FACTOR ? factor : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

/**
 * Most collateral Morpho hands over for at most `repayable` USDC of repayment. Morpho repays
 * `seized × price / LIF`, rounded up, so both floors here keep the result on the safe side.
 */
export function seizableFor(repayable: bigint, price: bigint, lltv: bigint): bigint {
  if (repayable <= 0n || price <= 0n) return 0n;
  const quoted = (repayable * liquidationIncentiveFactor(lltv)) / WAD;
  return (quoted * MORPHO_PRICE_SCALE) / price;
}

/** Upper bounds on `seizedAssets`. Above any one of them the vault or Morpho reverts. */
export interface SeizeCaps {
  /** Morpho: no more than the borrower posted. */
  readonly collateral: bigint;
  /** Vault OverCap: the vault prices the cap at the Core oracle, up to oracleBandBps above Morpho's. */
  readonly notional: bigint;
  /** Morpho: the repaid shares can't exceed the borrower's debt shares. */
  readonly debt: bigint;
  /** Vault callback: idle USDC must cover the repayment plus withdrawReserve. */
  readonly cash: bigint;
}

export type SizingState = Pick<VaultState, "market" | "risk" | "idleUsdc">;

export function seizeCaps(borrower: BorrowerState, state: SizingState): SeizeCaps {
  const { price, lltv } = state.market;
  const { maxLiquidation, oracleBandBps, withdrawReserve } = state.risk;
  // The vault's band check floors to whole bps, so allow one more than oracleBandBps.
  const shaveBps = BPS - oracleBandBps - 1n;
  const notional =
    price > 0n && shaveBps > 0n
      ? (((maxLiquidation * shaveBps) / BPS) * MORPHO_PRICE_SCALE) / price
      : 0n;
  return {
    collateral: borrower.collateral,
    notional,
    // borrowAssets is rounded up; Morpho's toAssetsDown is at most 1 lower.
    debt: seizableFor(borrower.borrowAssets - 1n, price, lltv),
    // the repayment goes shares-up then assets-up, which can add 2 units
    cash: seizableFor(state.idleUsdc - withdrawReserve - 2n, price, lltv),
  };
}

/** The largest `seizedAssets` the vault and Morpho will both accept. */
export function maxSeized(borrower: BorrowerState, state: SizingState): bigint {
  const caps = seizeCaps(borrower, state);
  return [caps.notional, caps.debt, caps.cash].reduce(
    (min, cap) => (cap < min ? cap : min),
    caps.collateral,
  );
}

/** RiskParams.cooldown(): shorter while the stock market is open. */
export function unwindCooldownSec(state: VaultState): bigint {
  return state.marketOpen ? state.risk.cooldownOpenSec : state.risk.cooldownClosedSec;
}

/** `lastUnwindAt == 0` means never unwound, so the first step is never blocked. */
export function cooldownElapsed(lastUnwindAt: bigint, now: bigint, cooldownSec: bigint): boolean {
  if (lastUnwindAt === 0n) return true;
  if (cooldownSec <= 0n) return true;
  return now >= lastUnwindAt + cooldownSec;
}

export function sameHex(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findBorrower(
  borrowers: readonly BorrowerState[],
  address: Address,
): BorrowerState | undefined {
  return borrowers.find((b) => sameAddress(b.address, address));
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

export interface Candidate {
  readonly address: Address;
  readonly label?: string;
}

/**
 * Fixed deployments.json candidates first, then any extra borrowers (Morpho API).
 * Deduplicated case-insensitively, order preserved.
 */
export function mergeCandidates(
  deployed: readonly DeploymentBorrower[],
  extra: readonly Address[],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const b of deployed) {
    const key = b.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: b.address, ...(b.label === undefined ? {} : { label: b.label }) });
  }
  for (const address of extra) {
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
  state: SizingState,
  label?: string,
): BorrowerReport {
  const { market } = state;
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
    maxSeizedAssets: maxSeized(borrower, state),
    ...(label === undefined ? {} : { label }),
  };
}

export function buildReports(
  state: SizingState & Pick<VaultState, "borrowers">,
  labels: ReadonlyMap<string, string> = new Map(),
): BorrowerReport[] {
  return state.borrowers.map((b) => borrowerReport(b, state, labels.get(b.address.toLowerCase())));
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export function evaluate(state: VaultState, now: bigint): Decision {
  const pending = state.pendingHedge;

  // 1. The retry loop never stops, not even while paused.
  if (pending.delta !== 0n) {
    if (state.blockNumber <= pending.sentBlock) {
      return { action: null, reason: "wait-same-block" };
    }
    if (now < pending.sentAt + state.risk.orderDelaySec) {
      return { action: null, reason: "wait-order-delay" };
    }
    return { action: { kind: "syncHedge" }, reason: "sync-ready" };
  }

  // Only the owner's `unpause` clears an owner pause.
  if ((state.pauseFlags & PAUSE_OWNER) !== 0n) {
    return { action: null, reason: "paused" };
  }

  // 2. Margin is back (or the hedge matches): the vault only notices on a sync. The keeper can't add margin
  //    itself (no bridge: the hedge account is funded on HyperCore), so while it's short this falls through.
  if (state.marginShortfall <= 0n && state.pauseFlags !== 0n) {
    return { action: { kind: "syncHedge" }, reason: "clear-pause" };
  }

  // 3. New liquidation, only when not paused.
  if (state.pauseFlags === 0n) {
    for (const borrower of state.borrowers) {
      if (!isLiquidatable(borrower, state.market.price, state.market.lltv)) continue;
      const seizedAssets = maxSeized(borrower, state);
      if (seizedAssets <= 0n) continue;
      return {
        action: {
          kind: "liquidate",
          marketId: state.market.id,
          borrower: borrower.address,
          seizedAssets,
        },
        reason: "liquidate-ready",
      };
    }
  }

  // 4. Unwind inventory in small chunks. Under a margin pause this is how the vault raises cash.
  if (state.inventory > 0n) {
    if (!cooldownElapsed(state.lastUnwindAt, now, unwindCooldownSec(state))) {
      return { action: null, reason: "unwind-cooldown" };
    }
    return { action: { kind: "unwindStep" }, reason: "unwind-ready" };
  }

  if (state.pauseFlags !== 0n) {
    return { action: null, reason: "paused" };
  }

  // No stock left. Margin stays put: the hedge account is funded on HyperCore, with no bridge to or from Base.
  if (state.confirmedShort !== 0n) {
    return { action: null, reason: "position-open" };
  }

  return { action: null, reason: "idle" };
}

/**
 * The spec's frozen signature, less its `cfg` argument: that only carried the USDC reserves for the margin
 * top-ups and withdrawals, which the keeper no longer makes. Use `evaluate` when a log reason is needed.
 */
export function decide(state: VaultState, now: bigint): Action | null {
  return evaluate(state, now).action;
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

const ok: GuardResult = { ok: true, reason: "ok" };
const fail = (reason: Exclude<GuardResult, { ok: true }>["reason"]): GuardResult => ({
  ok: false,
  reason,
});

/** Each guard mirrors the matching Seiz3VaultRemote function's own preconditions. */
export function guards(action: Action, state: VaultState, now: bigint): GuardResult {
  switch (action.kind) {
    case "syncHedge":
      return guardSync(state, now);
    case "liquidate":
      return guardLiquidate(action, state);
    case "unwindStep":
      return guardUnwind(state, now);
  }
}

/** Timing only matters with an order in flight; without one, a sync is worth sending only to clear a pause. */
function guardSync(state: VaultState, now: bigint): GuardResult {
  const pending = state.pendingHedge;
  if (pending.delta === 0n) {
    return (state.pauseFlags & (PAUSE_HEDGE | PAUSE_MARGIN)) !== 0n ? ok : fail("no-pending-hedge");
  }
  if (state.blockNumber <= pending.sentBlock) return fail("same-block");
  if (now < pending.sentAt + state.risk.orderDelaySec) return fail("order-delay");
  return ok;
}

function guardLiquidate(
  action: Extract<Action, { kind: "liquidate" }>,
  state: VaultState,
): GuardResult {
  if (state.pauseFlags !== 0n) return fail("vault-paused");
  if (state.pendingHedge.delta !== 0n) return fail("hedge-pending");
  if (!sameHex(action.marketId, state.market.id)) return fail("market-mismatch");

  const borrower = findBorrower(state.borrowers, action.borrower);
  if (borrower === undefined) return fail("unknown-borrower");
  if (!isLiquidatable(borrower, state.market.price, state.market.lltv)) {
    return fail("borrower-healthy");
  }
  if (action.seizedAssets <= 0n) return fail("zero-size");

  const caps = seizeCaps(borrower, state);
  if (action.seizedAssets > caps.collateral) return fail("size-exceeds-collateral");
  if (action.seizedAssets > caps.notional) return fail("size-exceeds-max-liquidation");
  if (action.seizedAssets > caps.debt) return fail("size-exceeds-debt");
  if (action.seizedAssets > caps.cash) return fail("size-exceeds-cash");
  return ok;
}

/** unwindStep runs under a hedge or margin pause, never under an owner pause or with a hedge in flight. */
function guardUnwind(state: VaultState, now: bigint): GuardResult {
  if ((state.pauseFlags & PAUSE_OWNER) !== 0n) return fail("vault-paused");
  if (state.pendingHedge.delta !== 0n) return fail("hedge-pending");
  if (state.inventory <= 0n) return fail("no-inventory");
  if (!cooldownElapsed(state.lastUnwindAt, now, unwindCooldownSec(state))) {
    return fail("cooldown-active");
  }
  return ok;
}
