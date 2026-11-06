/** Price converters for display. Decimals match contracts/src/libs/Units.sol. */

export const NVDAX_DECIMALS = 18;
export const USDC_DECIMALS = 6;

const p10 = (n: number) => 10n ** BigInt(n);

/** oraclePx precompile (perp) → human price. */
export const corePxToNumber = (raw: bigint, szDecimals: number) =>
  Number(raw) / 10 ** (6 - szDecimals);

/** Morpho 1e36-scaled oracle price → USD per NVDAx. */
export const morphoPxToNumber = (px: bigint) =>
  Number(px / p10(36 - NVDAX_DECIMALS)) / 10 ** USDC_DECIMALS;
