import type { MarketSnapshot } from "@afterbell/shared";

const TITLES: Record<MarketSnapshot["name"], string> = {
  A_naive: "Market A · Naive",
  B_conservative: "Market B · Conservative",
  C_afterbell: "Market C · Afterbell",
};

const usd = (v: string) =>
  (Number(v) / 1e6).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function MarketColumns({ markets }: { markets: MarketSnapshot[] }) {
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {markets.map((m) => {
        const badDebt = BigInt(m.badDebt) > 0n;
        return (
          <div key={m.name} className="rounded-xl border border-foreground/10 p-4">
            <h2 className="text-sm font-semibold">{TITLES[m.name]}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm tabular-nums">
              <dt className="opacity-60">LLTV</dt>
              <dd>{(m.lltv * 100).toFixed(1)}%</dd>
              <dt className="opacity-60">Debt</dt>
              <dd>{usd(m.borrower.debt)}</dd>
              <dt className="opacity-60">LTV</dt>
              <dd className={m.borrower.healthy ? "" : "text-red-500"}>
                {(m.borrower.ltv * 100).toFixed(1)}%
              </dd>
              <dt className="opacity-60">Bad debt</dt>
              <dd className={badDebt ? "font-semibold text-red-500" : "text-emerald-500"}>
                {usd(m.badDebt)}
              </dd>
            </dl>
          </div>
        );
      })}
    </section>
  );
}
