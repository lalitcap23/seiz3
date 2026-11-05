import type { HyperliquidPanel as Panel } from "@afterbell/shared";

export function HyperliquidPanel({ data, updatedAt }: { data: Panel | null; updatedAt: number }) {
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
        <a
          href={data.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs underline opacity-70"
        >
          explorer ↗
        </a>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
        <dt className="opacity-60">Size</dt>
        <dd>{data.size}</dd>
        <dt className="opacity-60">Entry</dt>
        <dd>{data.entryPx ?? "–"}</dd>
        <dt className="opacity-60">uPnL</dt>
        <dd className={data.unrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}>
          {data.unrealizedPnl.toFixed(2)}
        </dd>
        <dt className="opacity-60">Margin</dt>
        <dd>{data.marginUsed.toLocaleString()}</dd>
      </dl>
      <p className="mt-2 text-xs opacity-50">updated {new Date(updatedAt).toLocaleTimeString()}</p>
    </section>
  );
}
