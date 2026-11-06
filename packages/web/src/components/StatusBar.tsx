import type { Snapshot } from "@afterbell/shared";
import { price } from "@/lib/format";

/** The vault won't sell into a pool more than this far from HyperCore's price (RiskParams.oracleBandBps). */
const BAND = 0.015;

const drained = (pool: number, oracle: number) => oracle > 0 && pool < oracle / 2;

/** Where the weekend story stands: market closed or open, and whether the pool is a place the vault can sell into. */
export function StatusBar({ data }: { data: Snapshot }) {
  const oracle = data.hyperliquid?.oraclePx ?? 0;
  const gap = oracle > 0 ? data.pool.price / oracle - 1 : 0;
  const holding = BigInt(data.vault.inventory) > 0n;
  // testnet: market A dumps into its own thin pool, and the vault's pool stays deep
  const thin = data.thinPool;
  const pool =
    !thin && drained(data.pool.price, oracle)
      ? { text: "thin pool drained", tone: "text-red-500" }
      : holding && Math.abs(gap) > BAND
        ? { text: `${(gap * 100).toFixed(1)}% off HyperCore: the vault holds, hedged, and waits for buyers`, tone: "text-amber-500" }
        : { text: "in line with HyperCore", tone: "opacity-60" };

  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-foreground/10 px-4 py-3 text-sm">
      <span
        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
          data.marketOpen ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"
        }`}
      >
        {data.marketOpen ? "Monday · stock market open" : "Weekend · stock market closed"}
      </span>
      <span className="tabular-nums">
        <span className="opacity-60">NVDA on HyperCore </span>
        {oracle > 0 ? price(oracle) : "–"}
      </span>
      <span className="tabular-nums">
        <span className="opacity-60">{thin ? "Vault's v4 pool " : "Uniswap v4 pool "}</span>
        {price(data.pool.price)} <span className={pool.tone}>{pool.text}</span>
      </span>
      {thin && (
        <span className="tabular-nums">
          <span className="opacity-60">Market A&apos;s weekend pool </span>
          {price(thin.price)}{" "}
          {drained(thin.price, oracle) && <span className="text-red-500">thin pool drained</span>}
        </span>
      )}
      {/* prerendered in the server's timezone, shown in the viewer's */}
      <span className="ml-auto text-xs tabular-nums opacity-50" suppressHydrationWarning>
        block {data.blockNumber} · {new Date(data.updatedAt).toLocaleTimeString([], { hour12: false })}
      </span>
    </section>
  );
}
