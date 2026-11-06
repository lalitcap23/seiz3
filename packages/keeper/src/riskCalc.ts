/**
 * riskCalc.ts — all pure keeper-side risk calculation in one place.
 *
 * Units: USDC 6 dec, NVDAx 18 dec, WAD 1e18, BPS 10_000.
 * No clock access, no network, no floating point. bigint only.
 *
 * Sections:
 *   - units      decimal parse/format helpers
 *   - math       Morpho health/size math, mirrored from Morpho Blue and AfterbellVault
 *   - reports    borrower report rows for logs + the risk engine
 *   - decide     picks AT MOST ONE action per tick
 *   - guards     per-action preconditions, checked right before simulating
 *
 * `decide(state, now, cfg) -> Action | null` priority order (first match wins):
 *   1. syncHedge      pending delta != 0, later block, order delay elapsed
 *   2. topUpMargin    the vault reports a margin shortfall, idle USDC above reserve
 *   3. syncHedge      paused for hedge/margin, nothing pending, no shortfall: only a sync clears it
 *   4. liquidate      not paused, borrower LTV > LLTV
 *   5. unwindStep     inventory > 0, cooldown elapsed (also under a margin pause: it raises cash)
 *   6. withdrawMargin not paused, inventory == 0, short == 0, Core USDC above marginTarget + reserve
 *
 * Extra rules:
 *   - owner pause => syncHedge (when pending) is the ONLY possible action.
 *   - pending but not yet syncable => null. Nothing else runs in that tick.
 *   - `now` is the block timestamp the state was read at: the contract's clock.
 *   - Checks the keeper can't see from the EVM (pool vs Core price band, Core margin for a new
 *     short) are left to the eth_call simulation. A reverting simulation is skipped, never sent.
 *   - The keeper never signs HyperCore orders. Orders are sent by the vault.
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
  PolicyConfig,
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

// AfterbellVault pause flags
export const PAUSE_HEDGE = 1n;
export const PAUSE_MARGIN = 2n;
export const PAUSE_OWNER = 4n;

/** USDC 6-dec value of `collateral` (18 dec) at a Morpho 1e36 price. */
export function collateralValueUsdc(collateral: bigint, price: bigint): bigint {
  if (collateral <= 0n || price <= 0n) return 0n;
  return (collateral * price) / MORPHO_PRICE_SCALE;
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

/** Balance minus reserve, floored at zero. Never underflows. */
export function availableAfterReserve(balance: bigint, reserve: bigint): bigint {
  return balance > reserve ? balance - reserve : 0n;
}

/** The vault's shortfall plus 10%, as the spec asks. Non-owners may top up to 110% of marginTarget. */
export function topUpTarget(marginShortfall: bigint): bigint {
  return marginShortfall + marginShortfall / 10n;
}

/** Core USDC beyond what the next liquidation needs (vault.marginTarget) plus the keeper's slack. */
export function withdrawableCore(state: VaultState, cfg: PolicyConfig): bigint {
  return availableAfterReserve(state.coreUsdc, state.marginTarget + cfg.coreReserveUsdc);
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

export function evaluate(state: VaultState, now: bigint, cfg: PolicyConfig): Decision {
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

  // 2. Restore the margin buffer before any new risk.
  if (state.marginShortfall > 0n) {
    const available = availableAfterReserve(state.idleUsdc, cfg.idleReserveUsdc);
    const wanted = topUpTarget(state.marginShortfall);
    const amount = wanted < available ? wanted : available;
    if (amount > 0n) {
      return { action: { kind: "topUpMargin", amount }, reason: "topup-ready" };
    }
  } else if (state.pauseFlags !== 0n) {
    // 3. Margin is back (or the hedge matches): the vault only notices on a sync.
    return { action: { kind: "syncHedge" }, reason: "clear-pause" };
  }

  // 4. New liquidation, only when not paused.
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

  // 5. Unwind inventory in small chunks. Under a margin pause this is how the vault raises cash.
  if (state.inventory > 0n) {
    if (!cooldownElapsed(state.lastUnwindAt, now, unwindCooldownSec(state))) {
      return { action: null, reason: "unwind-cooldown" };
    }
    return { action: { kind: "unwindStep" }, reason: "unwind-ready" };
  }

  if (state.pauseFlags !== 0n) {
    return { action: null, reason: "paused" };
  }

  // 6. Return margin the next liquidation won't need once stock and short are both zero.
  if (state.confirmedShort !== 0n) {
    return { action: null, reason: "position-open" };
  }
  const withdrawable = withdrawableCore(state, cfg);
  if (withdrawable > 0n) {
    return { action: { kind: "withdrawMargin", amount: withdrawable }, reason: "withdraw-ready" };
  }
  if (state.coreUsdc > 0n) {
    return { action: null, reason: "core-at-reserve" };
  }

  return { action: null, reason: "idle" };
}

/** Frozen signature required by the spec. Use `evaluate` when a log reason is needed. */
export function decide(state: VaultState, now: bigint, cfg: PolicyConfig): Action | null {
  return evaluate(state, now, cfg).action;
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

const ok: GuardResult = { ok: true, reason: "ok" };
const fail = (reason: Exclude<GuardResult, { ok: true }>["reason"]): GuardResult => ({
  ok: false,
  reason,
});

/** Each guard mirrors the matching AfterbellVault function's own preconditions. */
export function guards(action: Action, state: VaultState, now: bigint, cfg: PolicyConfig): GuardResult {
  switch (action.kind) {
    case "syncHedge":
      return guardSync(state, now);
    case "topUpMargin":
      return guardTopUp(action.amount, state, cfg);
    case "liquidate":
      return guardLiquidate(action, state);
    case "unwindStep":
      return guardUnwind(state, now);
    case "withdrawMargin":
      return guardWithdraw(action.amount, state, cfg);
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

/** topUpMargin has no pause or pending check on chain: it only ever adds margin. */
function guardTopUp(amount: bigint, state: VaultState, cfg: PolicyConfig): GuardResult {
  if (amount <= 0n) return fail("amount-zero");
  if (state.marginShortfall <= 0n) return fail("no-margin-shortfall");
  if (amount > topUpTarget(state.marginShortfall)) return fail("topup-above-shortfall");
  const available = availableAfterReserve(state.idleUsdc, cfg.idleReserveUsdc);
  if (amount > available) return fail("insufficient-idle");
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

function guardWithdraw(amount: bigint, state: VaultState, cfg: PolicyConfig): GuardResult {
  if (state.pendingHedge.delta !== 0n) return fail("hedge-pending");
  if (state.inventory !== 0n || state.confirmedShort !== 0n) return fail("position-open");
  if (amount <= 0n) return fail("amount-zero");
  if (amount > withdrawableCore(state, cfg)) return fail("insufficient-core");
  return ok;
}
