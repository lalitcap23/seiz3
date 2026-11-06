import type { HyperliquidPanel as Panel } from "@afterbell/shared";
import { price } from "@/lib/format";

export function HyperliquidPanel({ data }: { data: Panel | null }) {
  if (!data) {
    return (
      <section className="rounded-xl border border-amber-500/40 p-4 text-sm">
        Hyperliquid data stale
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-foreground/10 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Hyperliquid · {data.coin}</h2>
        {data.explorerUrl ? (
          <a href={data.explorerUrl} target="_blank" rel="noreferrer" className="text-xs underline opacity-70">
            vault on the explorer ↗
          </a>
        ) : (
          <span className="text-xs opacity-50">local HyperCore</span>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm tabular-nums">
        <dt className="opacity-60">Position</dt>
        <dd className={data.size < 0 ? "font-semibold text-violet-500" : ""}>
          {data.size === 0 ? "flat" : `${data.size < 0 ? "short" : "long"} ${Math.abs(data.size)} NVDA`}
        </dd>
        <dt className="opacity-60">Entry</dt>
        <dd>{data.entryPx === null ? "–" : price(data.entryPx)}</dd>
        <dt className="opacity-60">Oracle / mark</dt>
        <dd>
          {price(data.oraclePx)} / {price(data.markPx)}
        </dd>
        <dt className="opacity-60">Unrealised PnL</dt>
        <dd className={data.unrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}>{price(data.unrealizedPnl)}</dd>
        <dt className="opacity-60">Margin used / account</dt>
        <dd>
          {price(data.marginUsed)} / {price(data.accountValue)}
        </dd>
      </dl>
    </section>
  );
}
