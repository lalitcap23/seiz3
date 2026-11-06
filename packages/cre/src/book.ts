// Pure math for the hedge-capacity half of the report: how much NVDA HyperCore's xyz book can take from the vault's
// hedge. The vault shorts with an IOC sell limited to oraclePx × (1 − hedgeCapBps), so every bid at or above that
// price can fill it. Their size, valued at the oracle (the price the vault's `maxLiquidation` check uses), is the
// capacity. Bigint throughout: this number sizes liquidations.

export interface Level {
  readonly px: string;
  readonly sz: string;
}

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** A plain non-negative decimal string ("214.7") as an integer with `decimals` places; extra places are cut. */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a plain decimal: ${value}`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac === "" ? "0" : frac);
}

/** Lowest bid the vault's IOC sell reaches, USDC 6 dec, rounded up so a bid below the limit never counts. */
export function hedgeFloorUsd6(oracleUsd6: bigint, hedgeCapBps: bigint): bigint {
  return (oracleUsd6 * (BPS - hedgeCapBps) + BPS - 1n) / BPS;
}

/** NVDA (18 dec) bid at or above the hedge floor. */
export function bidDepth(bids: readonly Level[], floorUsd6: bigint): bigint {
  let depth = 0n;
  for (const level of bids) {
    if (parseDecimal(level.px, 6) >= floorUsd6) depth += parseDecimal(level.sz, 18);
  }
  return depth;
}

/** USDC (6 dec) one hedge can sell into: depth inside the band × oracle, scaled by the share of the book we take. */
export function hedgeCapacityUsd6(
  bids: readonly Level[],
  oracleUsd6: bigint,
  hedgeCapBps: bigint,
  bookShareBps: bigint,
): bigint {
  const depth = bidDepth(bids, hedgeFloorUsd6(oracleUsd6, hedgeCapBps));
  return (((depth * oracleUsd6) / WAD) * bookShareBps) / BPS;
}
