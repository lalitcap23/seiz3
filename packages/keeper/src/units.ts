export const USDC_DECIMALS = 6;
export const NVDAX_DECIMALS = 18;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export function parseDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal: "${value}"`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = body.split(".");
  if (fraction.length > decimals) {
    throw new Error(`too many decimals for ${decimals}-dec value: "${value}"`);
  }
  const padded = fraction.padEnd(decimals, "0");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return negative ? -result : result;
}

export function parseUsdc(value: string): bigint {
  return parseDecimal(value, USDC_DECIMALS);
}

export function parseNvdax(value: string): bigint {
  return parseDecimal(value, NVDAX_DECIMALS);
}

export function formatDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function formatUsdc(value: bigint): string {
  return formatDecimal(value, USDC_DECIMALS);
}

export function formatNvdax(value: bigint): string {
  return formatDecimal(value, NVDAX_DECIMALS);
}
