/**
 * Pure bigint math shared by decide.ts and guards.ts.
 * No clock access, no network, no floating point.
 */

import type { Address, BorrowerState, Hex, PolicyConfig, VaultState } from "./types.js";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
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
