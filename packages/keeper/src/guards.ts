/**
 * guards.ts — per-action preconditions, checked by the executor immediately
 * before simulating a transaction.
 *
 * Pure: state in, result out. `now` is passed in, never read from a clock.
 *
 * Guards are deliberately redundant with `decide`. The vault re-checks
 * everything on-chain; guards exist to avoid wasted gas and noisy reverts.
 */

import {
  availableAfterReserve,
  cooldownElapsed,
  collateralValueUsdc,
  findBorrower,
  isLiquidatable,
  sameHex,
  seizedForCap,
  unwindCooldownSec,
} from "./math.js";
import type { Action, GuardResult, PolicyConfig, VaultState } from "./types.js";

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
