import type { MarketSnapshot } from "@afterbell/shared";
import { nvdax, price, usd } from "@/lib/format";

const TITLES: Record<MarketSnapshot["name"], string> = {
  A_naive: "Market A · Naive",
  B_conservative: "Market B · Conservative",
  C_afterbell: "Market C · Afterbell",
};

const LIQUIDATOR: Record<MarketSnapshot["name"], string> = {
  A_naive: "dumps seized stock into the thin pool",
  B_conservative: "low LLTV, nothing to liquidate",
  C_afterbell: "the vault buys it and shorts on HyperCore",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** What a judge should read off the column at a glance. */
function status(m: MarketSnapshot): { label: string; tone: string } {
  if (m.borrower.address === ZERO_ADDRESS) return { label: "No borrower", tone: "bg-foreground/10" };
  if (BigInt(m.badDebt) > 0n) return { label: "Liquidated · bad debt", tone: "bg-red-500/15 text-red-500" };
  if (!m.borrower.healthy) return { label: "Liquidatable", tone: "bg-amber-500/15 text-amber-500" };
  if (Number(m.borrower.debt) < 1e6) return { label: "Liquidated · lenders repaid", tone: "bg-emerald-500/15 text-emerald-500" };
  return { label: "Healthy", tone: "bg-emerald-500/15 text-emerald-500" };
}

export function MarketColumns({ markets }: { markets: MarketSnapshot[] }) {
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {markets.map((m) => {
        const s = status(m);
        const badDebt = BigInt(m.badDebt) > 0n;
        const collateral = nvdax(m.borrower.collateral);
        return (
          <div
            key={m.name}
            className={`rounded-xl border p-4 ${m.name === "C_afterbell" ? "border-emerald-500/40" : "border-foreground/10"}`}
          >
            <h2 className="text-sm font-semibold">{TITLES[m.name]}</h2>
            <p className="text-xs opacity-60">{LIQUIDATOR[m.name]}</p>
            <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm tabular-nums">
              <dt className="opacity-60">NVDA price</dt>
              <dd>{price(m.oraclePrice)}</dd>
              <dt className="opacity-60">Collateral</dt>
              <dd>
                {collateral.toFixed(1)} · {usd(String(Math.round(collateral * m.oraclePrice * 1e6)))}
              </dd>
              <dt className="opacity-60">Debt</dt>
              <dd>{usd(m.borrower.debt)}</dd>
              <dt className="opacity-60">LTV / LLTV</dt>
              <dd className={m.borrower.healthy ? "" : "text-red-500"}>
                {(m.borrower.ltv * 100).toFixed(1)}% / {(m.lltv * 100).toFixed(1)}%
              </dd>
              <dt className="opacity-60">Bad debt</dt>
              <dd className={badDebt ? "font-semibold text-red-500" : "text-emerald-500"}>{usd(m.badDebt)}</dd>
            </dl>
          </div>
        );
      })}
    </section>
  );
}
