/** Morpho Blue position maths for the browser (the keeper's tested copy is packages/keeper/src/riskCalc.ts). */

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

/** MathLib `wTaylorCompounded`: e^(rate × elapsed) − 1 to three terms, WAD. */
function wTaylorCompounded(rate: bigint, elapsed: bigint): bigint {
  const first = rate * elapsed;
  const second = (first * first) / (2n * WAD);
  return first + second + (second * first) / (3n * WAD);
}

/** totalBorrowAssets after `_accrueInterest`: the stored total lags until someone touches the market. */
export function accruedTotalBorrow(totalBorrowAssets: bigint, ratePerSec: bigint, elapsed: bigint): bigint {
  if (ratePerSec <= 0n || elapsed <= 0n) return totalBorrowAssets;
  return totalBorrowAssets + (totalBorrowAssets * wTaylorCompounded(ratePerSec, elapsed)) / WAD;
}

/** SharesMathLib `toAssetsUp`: what a borrower owes for `shares`. */
export function debtOf(shares: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  if (shares <= 0n) return 0n;
  const d = totalBorrowShares + VIRTUAL_SHARES;
  return (shares * (totalBorrowAssets + VIRTUAL_ASSETS) + d - 1n) / d;
}

/** Most a position may owe and stay healthy: collateral × price / 1e36 × LLTV, rounded down as Morpho does. */
export function maxDebt(collateral: bigint, price: bigint, lltv: bigint): bigint {
  return (((collateral * price) / ORACLE_PRICE_SCALE) * lltv) / WAD;
}

/** USDC (6 dec) price of 1 NVDAx at which the position becomes liquidatable. */
export function liquidationPriceUsd6(collateral: bigint, debt: bigint, lltv: bigint): bigint {
  if (collateral === 0n || lltv === 0n) return 0n;
  return (debt * WAD * 10n ** 18n) / (collateral * lltv);
}
