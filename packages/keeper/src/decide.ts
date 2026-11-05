/**
 * decide.ts — the pure heart of the keeper.
 *
 * `decide(state, now, cfg) -> Action | null` picks AT MOST ONE action per tick.
 * `evaluate(state, now, cfg)` returns the same action plus the reason that
 * produced it, so the tick loop can log every decision (including nulls).
 *
 * Priority order (first match wins):
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

import {
  availableAfterReserve,
  cooldownElapsed,
  firstLiquidatable,
  seizedForCap,
  unwindCooldownSec,
} from "./math.js";
import type { Action, Decision, PolicyConfig, VaultState } from "./types.js";

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
