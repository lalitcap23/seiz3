import { formatUnits, type Hex } from "viem";

/**
 * A decimal string from Hyperliquid's API ("-1.162", "212.2915") as an integer with `decimals` decimals, rounded half
 * away from zero. Exact: no float ever touches a size, price or balance.
 */
export function decToBig(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal: ${value}`);
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  let n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept || "0");
  if (frac.length > decimals && Number(frac[decimals]) >= 5) n += 1n;
  return negative ? -n : n;
}

/** Wire value (human × 1e8, CoreWriter's price and size encoding) → the decimal string Hyperliquid's API takes. */
export function wireToDec(wire: bigint): string {
  return formatUnits(wire, 8);
}

/** uint128 client order id → the 16-byte hex Hyperliquid's API takes. */
export function cloidHex(cloid: bigint): Hex {
  return `0x${cloid.toString(16).padStart(32, "0")}`;
}

export function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
