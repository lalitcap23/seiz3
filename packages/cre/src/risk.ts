// Pure decision logic for the Afterbell CRE workflow — mirrors the keeper's risk engine checks
// (oracle band, position health, size caps) so the same rules run inside the CRE orchestration layer.
// The contract remains the final authority: even a wrong decision here reverts in AfterbellVault.

export interface PositionRead {
  readonly collateral: bigint; // 18 decimals (NVDAx)
  readonly borrowShares: bigint; // Morpho borrow shares (~= assets for small markets)
}

export interface RiskParams {
  readonly lltv: bigint; // 1e18 (0.77e18 = 77%)
  readonly oracleBandBps: bigint; // lending oracle vs Hyperliquid oracle, basis points
  readonly maxSeizedUsdc: bigint; // 6 decimals cap, mirrors RiskParams.maxLiquidation intent
}

export type Assessment =
  | { readonly action: "liquidate"; readonly seized: bigint; readonly detail: string }
  | { readonly action: "skip"; readonly reason: string };

const WAD = 1_000_000_000_000_000_000n; // 1e18
const USDC = 1_000_000n; // 1e6
const BPS = 10_000n;

/**
 * Decide whether to liquidate. `lendingPriceUsd6` and `corePriceUsd6` are USDC (6-dec) per NVDAx.
 * All quantities integer; health math in WAD precision.
 */
export function assess(
  lendingPriceUsd6: bigint,
  corePriceUsd6: bigint,
  position: PositionRead,
  params: RiskParams,
): Assessment {
  if (position.collateral === 0n) return { action: "skip", reason: "no collateral" };
  if (position.borrowShares === 0n) return { action: "skip", reason: "no debt" };
  if (lendingPriceUsd6 <= 0n || corePriceUsd6 <= 0n) return { action: "skip", reason: "non-positive price" };

  // 1. Oracle band: refuse liquidations on a broken price (contract enforces this too).
  const gap = lendingPriceUsd6 > corePriceUsd6 ? lendingPriceUsd6 - corePriceUsd6 : corePriceUsd6 - lendingPriceUsd6;
  const gapBps = (gap * BPS) / corePriceUsd6;
  if (gapBps > params.oracleBandBps) {
    return {
      action: "skip",
      reason: `oracle band: ${Number(gapBps) / 100}% > ${Number(params.oracleBandBps) / 100}%`,
    };
  }

  // 2. Health: collateral value (at the Core price) × LLTV vs debt. ~= shares for the demo markets.
  const collateralUsdc = (position.collateral * corePriceUsd6) / WAD;
  const debtUsdc = position.borrowShares; // Morpho virtual-assets ≈ 1; exact math lives in the keeper
  const healthUsdc = (collateralUsdc * params.lltv) / WAD;
  if (healthUsdc >= debtUsdc) {
    const hfBps = (healthUsdc * BPS) / debtUsdc;
    return { action: "skip", reason: `healthy: health ${Number(hfBps) / 100}% of debt` };
  }

  // 3. Seize size: Morpho's liquidation incentive caps at debt × (1/LLTV), so seize that (or all
  //    collateral if smaller), then respect the workflow's own cap. The vault re-checks everything.
  const incentiveSeized = (debtUsdc * WAD) / params.lltv; // in NVDAx 18-dec terms
  const capSeized = (params.maxSeizedUsdc * WAD) / corePriceUsd6;
  let seized = position.collateral;
  if (incentiveSeized < seized) seized = incentiveSeized;
  if (capSeized < seized) seized = capSeized;
  if (seized <= 0n) return { action: "skip", reason: "seized size zero after caps" };

  const seizedUsdc = (seized * corePriceUsd6) / WAD;
  return {
    action: "liquidate",
    seized,
    detail: `underwater: debt $${debtUsdc / USDC}, collateral $${collateralUsdc / USDC}, seizing $${seizedUsdc / USDC}`,
  };
}
