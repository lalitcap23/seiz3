import Link from "next/link";
import type { BorrowerRow, MarketSnapshot } from "@afterbell/shared";
import { nvdax, price, shortHash, usd } from "@/lib/format";
import { OpBadge } from "./OperationCard";

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

const BORROWERS_SHOWN = 5;
const LIQUIDATIONS_SHOWN = 4;

/** Morpho has no "liquidated" flag: a loan with collateral but (next to) no debt left was cleared. */
function status(b: BorrowerRow, lltv: number): { label: string; tone: string } {
  if (!b.healthy) return { label: "Liquidatable", tone: "bg-red-500/15 text-red-500" };
  if (Number(b.debt) < 10_000) return { label: "No debt", tone: "bg-foreground/10" };
  if (b.ltv > 0.95 * lltv) return { label: "At the limit", tone: "bg-amber-500/15 text-amber-500" };
  return { label: "Healthy", tone: "bg-emerald-500/15 text-emerald-500" };
}

function Borrower({ b, lltv }: { b: BorrowerRow; lltv: number }) {
  const s = status(b, lltv);
  const fill = Math.min(1, b.ltv / lltv);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono">{shortHash(b.address)}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${s.tone}`}>{s.label}</span>
        <span className="ml-auto tabular-nums opacity-70">
          {usd(b.debt, 2)} · {nvdax(b.collateral).toFixed(4)} NVDAx
        </span>
      </div>
      {/* LTV against the market's LLTV: the bar fills up as the loan nears liquidation */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={`h-full ${b.healthy ? (fill > 0.95 ? "bg-amber-500" : "bg-emerald-500") : "bg-red-500"}`}
            style={{ width: `${fill * 100}%` }}
          />
        </div>
        <span className="w-24 text-right text-[10px] tabular-nums opacity-60">
          {(b.ltv * 100).toFixed(2)}% / {(lltv * 100).toFixed(0)}%
        </span>
      </div>
    </li>
  );
}

export function MarketColumns({ markets }: { markets: MarketSnapshot[] }) {
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {markets.map((m) => {
        const badDebt = BigInt(m.badDebt) > 0n;
        const borrowers = (m.borrowers ?? []).filter((b) => BigInt(b.debt) > 0n || BigInt(b.collateral) > 0n);
        const open = borrowers.filter((b) => Number(b.debt) >= 10_000);
        const liquidatable = borrowers.filter((b) => !b.healthy).length;
        const liquidations = [...(m.liquidations ?? [])].reverse();
        return (
          <div
            key={m.name}
            className={`flex flex-col gap-3 rounded-xl border p-4 ${m.name === "C_afterbell" ? "border-emerald-500/40" : "border-foreground/10"}`}
          >
            <div>
              <h2 className="text-sm font-semibold">{TITLES[m.name]}</h2>
              <p className="text-xs opacity-60">{LIQUIDATOR[m.name]}</p>
            </div>
            <dl className="grid grid-cols-2 gap-y-1 text-sm tabular-nums">
              <dt className="opacity-60">NVDA price</dt>
              <dd>{price(m.oraclePrice)}</dd>
              <dt className="opacity-60">Total borrowed</dt>
              <dd>{usd(m.totalBorrow, 2)}</dd>
              <dt className="opacity-60">Collateral</dt>
              <dd>
                {nvdax(m.totalCollateral).toFixed(4)} · {usd(String(Math.round(nvdax(m.totalCollateral) * m.oraclePrice * 1e6)))}
              </dd>
              <dt className="opacity-60">Open loans</dt>
              <dd>
                {open.length}
                {liquidatable > 0 && <span className="ml-2 text-red-500">{liquidatable} liquidatable</span>}
              </dd>
              <dt className="opacity-60">LLTV</dt>
              <dd>{(m.lltv * 100).toFixed(1)}%</dd>
              <dt className="opacity-60">Bad debt</dt>
              <dd className={badDebt ? "font-semibold text-red-500" : "text-emerald-500"}>{usd(m.badDebt)}</dd>
            </dl>

            {borrowers.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-medium opacity-70">Borrowers, riskiest first</h3>
                <ul className="flex flex-col gap-2">
                  {borrowers.slice(0, BORROWERS_SHOWN).map((b) => (
                    <Borrower key={b.address} b={b} lltv={m.lltv} />
                  ))}
                </ul>
                {borrowers.length > BORROWERS_SHOWN && (
                  <p className="mt-1 text-[10px] opacity-50">and {borrowers.length - BORROWERS_SHOWN} more</p>
                )}
              </div>
            )}

            {liquidations.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-medium opacity-70">Liquidations</h3>
                <ul className="flex flex-col gap-1 text-xs">
                  {liquidations.slice(0, LIQUIDATIONS_SHOWN).map((l) => (
                    <li key={l.txHash} className="flex flex-wrap items-center gap-x-2">
                      {l.opId ? <OpBadge id={l.opId} /> : <span className="text-[10px] opacity-60">{l.by === "naive" ? "naive" : "other"}</span>}
                      <span className="font-mono">{shortHash(l.borrower)}</span>
                      <span className="opacity-70">
                        repaid {usd(l.repaid, 2)}, seized {nvdax(l.seized).toFixed(4)}
                        {BigInt(l.badDebt) > 0n && <span className="text-red-500">, bad debt {usd(l.badDebt, 2)}</span>}
                      </span>
                      <Link href={`/tx/${l.txHash}`} className="ml-auto font-mono text-[11px] underline opacity-50 hover:opacity-100">
                        {shortHash(l.txHash)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
