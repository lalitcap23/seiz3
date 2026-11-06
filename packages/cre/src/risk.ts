// Pure decision logic for the Afterbell CRE workflow — an exact mirror of Morpho Blue's
// liquidation check, the vault's oracle-band rule, and the keeper's sizing caps
// (packages/keeper/src/riskCalc.ts). Keeping this identical matters: a decision that is even
// slightly too optimistic reverts in Morpho (`HEALTHY_POSITION`) or the vault (`OracleBand`,
// `OverCap`), wasting the DON's write.
//
// Units:
//   collateral     18 decimals (NVDAx wei)
//   borrowAssets    6 decimals (USDC)
//   prices          6 decimals (USDC per NVDAx)
//   lltv          1e18 (0.77e18 = 77%)

export interface PositionRead {
  readonly collateral: bigint;
  readonly borrowAssets: bigint;
}

export interface RiskParams {
  readonly lltv: bigint;
  readonly oracleBandBps: bigint;
  /** Vault RiskParams.maxLiquidation: max seized notional per liquidation, USDC 6 dec. */
  readonly maxSeizedUsdc: bigint;
  /** HyperCore size decimals; the vault reverts ZeroSize below one core lot. */
  readonly szDecimals: number;
}

export type Assessment =
  | { readonly action: "liquidate"; readonly seized: bigint; readonly detail: string }
  | { readonly action: "skip"; readonly reason: string };

const WAD = 1_000_000_000_000_000_000n; // 1e18
const USDC = 1_000_000n; // 1e6
const BPS = 10_000n;

// Morpho Blue constants (Morpho.sol / SharesMathLib.sol)
const LIQUIDATION_CURSOR = 300_000_000_000_000_000n; // 0.3e18
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n; // 1.15e18
const VIRTUAL_SHARES = 1_000_000n; // 1e6
const VIRTUAL_ASSETS = 1n;

/** Morpho `SharesMathLib.toAssetsUp`: borrow shares → debt, rounded against the borrower. */
export function toBorrowAssetsUp(
  shares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
): bigint {
  if (shares <= 0n) return 0n;
  const numerator = shares * (totalBorrowAssets + VIRTUAL_ASSETS);
  const denominator = totalBorrowShares + VIRTUAL_SHARES;
  return (numerator + denominator - 1n) / denominator;
}

/** Morpho's bonus: min(1.15, 1 / (1 − 0.3 × (1 − LLTV))), WAD. ≈1.0741 at 77% LLTV. */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  if (lltv <= 0n || lltv > WAD) return WAD;
  const denominator = WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD;
  const factor = (WAD * WAD) / denominator;
  return factor < MAX_LIQUIDATION_INCENTIVE_FACTOR ? factor : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

/** Most collateral Morpho hands over for at most `repayable` USDC of repayment, 18-dec. */
export function seizableFor(repayable: bigint, priceUsd6: bigint, lltv: bigint): bigint {
  if (repayable <= 0n || priceUsd6 <= 0n) return 0n;
  const quotedUsdc = (repayable * liquidationIncentiveFactor(lltv)) / WAD;
  return (quotedUsdc * WAD) / priceUsd6;
}

/**
 * Decide whether to liquidate. `lendingPriceUsd6` is what Morpho's oracle reports (the price
 * that decides liquidatability and the seizure amount); `corePriceUsd6` is Hyperliquid's oracle
 * (the price the vault uses for its notional cap and the band check).
 */
export function assess(
  lendingPriceUsd6: bigint,
  corePriceUsd6: bigint,
  position: PositionRead,
  params: RiskParams,
): Assessment {
  if (position.collateral === 0n) return { action: "skip", reason: "no collateral" };
  if (position.borrowAssets === 0n) return { action: "skip", reason: "no debt" };
  if (lendingPriceUsd6 <= 0n || corePriceUsd6 <= 0n) {
    return { action: "skip", reason: "non-positive price" };
  }

  // 1 · Oracle band: never size a trade across a broken/stale lending oracle.
  const gap =
    lendingPriceUsd6 > corePriceUsd6
      ? lendingPriceUsd6 - corePriceUsd6
      : corePriceUsd6 - lendingPriceUsd6;
  const gapBps = (gap * BPS) / corePriceUsd6;
  if (gapBps > params.oracleBandBps) {
    return {
      action: "skip",
      reason: `oracle band: ${Number(gapBps) / 100}% > ${Number(params.oracleBandBps) / 100}%`,
    };
  }

  // 2 · Health, exactly as Morpho computes it with its own oracle:
  //     collateral × price / 1e36 × LLTV < borrowAssets  →  liquidatable.
  const collateralValueUsdc = (position.collateral * lendingPriceUsd6) / WAD;
  const maxBorrowUsdc = (collateralValueUsdc * params.lltv) / WAD;
  if (maxBorrowUsdc >= position.borrowAssets) {
    const hfBps = (maxBorrowUsdc * BPS) / position.borrowAssets;
    return { action: "skip", reason: `healthy: health ${Number(hfBps) / 100}% of debt` };
  }

  // 3 · Size: min(collateral, what the debt can repay, the vault's notional cap).
  //     The vault prices its cap at the Core oracle, so compute that cap at corePrice.
  const debtSeized = seizableFor(position.borrowAssets - 1n, lendingPriceUsd6, params.lltv);
  const capSeized = (params.maxSeizedUsdc * WAD) / corePriceUsd6;
  let seized = position.collateral;
  if (debtSeized < seized) seized = debtSeized;
  if (capSeized < seized) seized = capSeized;

  const minSeized = 10n ** (18n - BigInt(params.szDecimals));
  if (seized < minSeized) {
    return { action: "skip", reason: `below one core lot (${minSeized} wei)` };
  }

  const seizedUsdc = (seized * corePriceUsd6) / WAD;
  return {
    action: "liquidate",
    seized,
    detail: `underwater: debt $${position.borrowAssets / USDC}, collateral $${collateralValueUsdc / USDC}, seizing $${seizedUsdc / USDC}`,
  };
}
