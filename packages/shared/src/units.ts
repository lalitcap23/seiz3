/** TS mirror of contracts/src/libs/Units.sol. Keep the two in lock-step. */

export const NVDAX_DECIMALS = 18;
export const USDC_DECIMALS = 6;
export const CORE_WIRE_DECIMALS = 8;

const p10 = (n: number) => 10n ** BigInt(n);

/** NVDAx (18 dec) → Core size units (szDecimals), rounded down. */
export const toCoreSize = (nvdax: bigint, szDecimals: number) =>
  nvdax / p10(NVDAX_DECIMALS - szDecimals);

/** Core size units → NVDAx (18 dec). */
export const fromCoreSize = (sz: bigint, szDecimals: number) =>
  (sz < 0n ? -sz : sz) * p10(NVDAX_DECIMALS - szDecimals);

/** Core size units → CoreWriter wire sz (human × 1e8). */
export const sizeToWire = (sz: bigint, szDecimals: number) =>
  sz * p10(CORE_WIRE_DECIMALS - szDecimals);

/** oraclePx precompile (perp) → human price. */
export const corePxToNumber = (raw: bigint, szDecimals: number) =>
  Number(raw) / 10 ** (6 - szDecimals);

/** Morpho 1e36-scaled oracle price → USD per NVDAx. */
export const morphoPxToNumber = (px: bigint) =>
  Number(px / p10(36 - NVDAX_DECIMALS)) / 10 ** USDC_DECIMALS;

/** USD per NVDAx → Morpho 1e36-scaled price (6/18 dec). */
export const numberToMorphoPx = (usd: number) =>
  BigInt(Math.round(usd * 10 ** USDC_DECIMALS)) * p10(36 - NVDAX_DECIMALS);

/** HIP-3 asset id = 100000 + perpDexIndex × 10000 + indexInMeta. */
export const hip3AssetId = (perpDexIndex: number, indexInMeta: number) =>
  100_000 + perpDexIndex * 10_000 + indexInMeta;

export const formatUsdc = (v: bigint) => Number(v) / 10 ** USDC_DECIMALS;
export const formatNvdax = (v: bigint) => Number(v) / 10 ** NVDAX_DECIMALS;
