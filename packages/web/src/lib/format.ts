/** USDC (6 dec, as a decimal string or bigint) → "$16,492". */
export const usd = (v: string | bigint, digits = 0) =>
  (Number(v) / 1e6).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** A plain dollar number → "$205.00". */
export const price = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** NVDAx (18 dec) → NVDA as a number. */
export const nvdax = (v: string | bigint) => Number(v) / 1e18;

/** HyperCore size units → NVDA as a number. */
export const coreSize = (v: string | bigint, szDecimals: number) => Number(v) / 10 ** szDecimals;

/** A ratio → "+1.25%" / "−0.40%". */
export const signedPct = (v: number, digits = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(digits)}%`;

export const shortHash =(hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
