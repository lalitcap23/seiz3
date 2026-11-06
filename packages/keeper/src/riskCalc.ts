/**
 * riskCalc.ts — all pure keeper-side risk calculation in one place.
 *
 * Units: USDC 6 dec, NVDAx 18 dec, WAD 1e18, BPS 10_000.
 * No clock access, no network, no floating point. bigint only.
 *
 * Sections:
 *   - units      decimal parse/format helpers
 *   - math       Morpho health/size math
 *   - reports    borrower report rows for logs + the risk engine
 *   - decide     picks AT MOST ONE action per tick
 *   - guards     per-action preconditions, checked right before simulating
 *
 * `decide(state, now, cfg) -> Action | null` priority order (first match wins):
 *   1. syncHedge      pending delta != 0, later block, order delay elapsed
 *   2. topUpMargin    margin below buffer, enough idle USDC above reserve
 *   3. liquidate      not paused, no pending, borrower LTV > LLTV
 *   4. unwindStep     not paused, no pending, inventory > 0, cooldown elapsed
 *   5. withdrawMargin inventory == 0, short == 0, Core USDC above reserve
 *
 * Extra rules:
 *   - paused => syncHedge is the ONLY possible action.
 *   - pending but not yet syncable => null. Nothing else runs in that tick.
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
  MarketState,
  PolicyConfig,
  Risk,
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

/** USDC 6-dec value of `collateral` (18 dec) at a Morpho 1e36 price. */
export function collateralValueUsdc(collateral: bigint, price: bigint): bigint {
  if (collateral <= 0n || price <= 0n) return 0n;
  return (collateral * price) / MORPHO_PRICE_SCALE;
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

/**
 * Largest collateral amount whose USDC value stays at or below the
 * per-liquidation cap, further capped by the borrower's collateral.
 */
export function seizedForCap(
  maxLiquidationUsdc: bigint,
  price: bigint,
  collateral: bigint,
): bigint {
  if (maxLiquidationUsdc <= 0n || price <= 0n || collateral <= 0n) return 0n;
  const byCap = (maxLiquidationUsdc * MORPHO_PRICE_SCALE) / price;
  return byCap < collateral ? byCap : collateral;
}

/** Balance minus reserve, floored at zero. Never underflows. */
export function availableAfterReserve(balance: bigint, reserve: bigint): bigint {
  return balance > reserve ? balance - reserve : 0n;
}

/**
 * Cooldown between unwind steps. Shorter when the market is open.
 * `risk.unwindCooldownSec` is the closed-market base value from the vault.
 */
export function unwindCooldownSec(state: VaultState, cfg: PolicyConfig): bigint {
  return state.marketOpen ? cfg.unwindCooldownOpenSec : state.risk.unwindCooldownSec;
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

export function firstLiquidatable(
  borrowers: readonly BorrowerState[],
  price: bigint,
  lltv: bigint,
): BorrowerState | undefined {
  return borrowers.find((b) => isLiquidatable(b, price, lltv));
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

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

  // A pending-but-not-syncable hedge already returned above. Pause stops new
  // risk only, and with no pending hedge there is nothing else to do.
  if (state.paused) {
    return { action: null, reason: "paused" };
  }

  // 2. Margin top-up before any new risk.
  const availableIdle = availableAfterReserve(state.idleUsdc, cfg.idleReserveUsdc);
  if (state.marginRatioBps < state.risk.marginBufferBps && availableIdle > 0n && cfg.topUpUsdc > 0n) {
    const amount = cfg.topUpUsdc < availableIdle ? cfg.topUpUsdc : availableIdle;
    if (amount > 0n) {
      return { action: { kind: "topUpMargin", amount }, reason: "topup-ready" };
    }
  }

  // 3. New liquidation, only when idle.
  const borrower = firstLiquidatable(state.borrowers, state.market.price, state.market.lltv);
  if (borrower !== undefined) {
    const seizedAssets = seizedForCap(
      state.risk.maxLiquidation,
      state.market.price,
      borrower.collateral,
    );
    if (seizedAssets > 0n) {
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

  // 4. Unwind inventory in small chunks.
  if (state.inventory > 0n) {
    if (!state.poolPriceInBand) {
      return { action: null, reason: "pool-out-of-band" };
    }
    if (!cooldownElapsed(state.lastUnwindAt, now, unwindCooldownSec(state, cfg))) {
      return { action: null, reason: "unwind-cooldown" };
    }
    return { action: { kind: "unwindStep" }, reason: "unwind-ready" };
  }

  // 5. Return margin once stock and short are both zero.
  if (state.confirmedShort !== 0n) {
    return { action: null, reason: "position-open" };
  }
  const availableCore = availableAfterReserve(state.coreUsdc, cfg.coreReserveUsdc);
  if (availableCore > 0n) {
    return { action: { kind: "withdrawMargin", amount: availableCore }, reason: "withdraw-ready" };
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

export function guards(action: Action, state: VaultState, now: bigint, cfg: PolicyConfig): GuardResult {
  const pending = state.pendingHedge;

  // Pause stops new risk, never the sync retry loop.
  if (action.kind !== "syncHedge") {
    if (state.paused) return fail("vault-paused");
    if (pending.delta !== 0n) return fail("hedge-pending");
  }

  switch (action.kind) {
    case "syncHedge":
      return guardSync(state, now);
    case "topUpMargin":
      return guardTopUp(action.amount, state, cfg);
    case "liquidate":
      return guardLiquidate(action, state);
    case "unwindStep":
      return guardUnwind(state, now, cfg);
    case "withdrawMargin":
      return guardWithdraw(action.amount, state, cfg);
  }
}

function guardSync(state: VaultState, now: bigint): GuardResult {
  const pending = state.pendingHedge;
  if (pending.delta === 0n) return fail("no-pending-hedge");
  if (state.blockNumber <= pending.sentBlock) return fail("same-block");
  if (now < pending.sentAt + state.risk.orderDelaySec) return fail("order-delay");
  return ok;
}

function guardTopUp(amount: bigint, state: VaultState, cfg: PolicyConfig): GuardResult {
  if (state.marginRatioBps >= state.risk.marginBufferBps) return fail("margin-above-buffer");
  if (amount <= 0n) return fail("amount-zero");
  const available = availableAfterReserve(state.idleUsdc, cfg.idleReserveUsdc);
  if (amount > available) return fail("insufficient-idle");
  return ok;
}

function guardLiquidate(
  action: Extract<Action, { kind: "liquidate" }>,
  state: VaultState,
): GuardResult {
  if (!sameHex(action.marketId, state.market.id)) return fail("market-mismatch");

  const borrower = findBorrower(state.borrowers, action.borrower);
  if (borrower === undefined) return fail("unknown-borrower");
  if (!isLiquidatable(borrower, state.market.price, state.market.lltv)) {
    return fail("borrower-healthy");
  }
  if (action.seizedAssets <= 0n) return fail("zero-size");
  if (action.seizedAssets > borrower.collateral) return fail("size-exceeds-collateral");

  const value = collateralValueUsdc(action.seizedAssets, state.market.price);
  if (value > state.risk.maxLiquidation) return fail("size-exceeds-max-liquidation");

  // Sanity: the guard must accept exactly the size decide would pick.
  const maxSeized = seizedForCap(state.risk.maxLiquidation, state.market.price, borrower.collateral);
  if (action.seizedAssets > maxSeized) return fail("size-exceeds-max-liquidation");

  return ok;
}

function guardUnwind(state: VaultState, now: bigint, cfg: PolicyConfig): GuardResult {
  if (state.inventory <= 0n) return fail("no-inventory");
  if (!state.poolPriceInBand) return fail("pool-out-of-band");
  if (!cooldownElapsed(state.lastUnwindAt, now, unwindCooldownSec(state, cfg))) {
    return fail("cooldown-active");
  }
  return ok;
}

function guardWithdraw(amount: bigint, state: VaultState, cfg: PolicyConfig): GuardResult {
  if (state.inventory !== 0n || state.confirmedShort !== 0n) return fail("position-open");
  if (amount <= 0n) return fail("amount-zero");
  const available = availableAfterReserve(state.coreUsdc, cfg.coreReserveUsdc);
  if (amount > available) return fail("insufficient-core");
  return ok;
}
