import type { BorrowerRow, MarketSnapshot } from "@seiz3/shared";
import { nvdax, price, shortHash, usd } from "@/lib/format";
import { OpBadge } from "./OperationCard";
import { Label, Meter, Panel, Stat, Tag, TxLink, type Tone } from "./ui";

const TITLES: Record<MarketSnapshot["name"], { name: string; tag: string; tone: Tone }> = {
  A_naive: { name: "Market A", tag: "naive", tone: "muted" },
  B_conservative: { name: "Market B", tag: "conservative", tone: "muted" },
  C_seiz3: { name: "Market C", tag: "seiz3", tone: "brand" },
};

const LIQUIDATOR: Record<MarketSnapshot["name"], string> = {
  A_naive: "dumps seized stock into the thin pool",
  B_conservative: "low LLTV, nothing to liquidate",
  C_seiz3: "the vault buys it and shorts on HyperCore",
};

const BORROWERS_SHOWN = 5;
const LIQUIDATIONS_SHOWN = 4;

/** Morpho has no "liquidated" flag: a loan with collateral but (next to) no debt left was cleared. */
export function borrowerStatus(b: BorrowerRow, lltv: number): { label: string; title: string; tone: Tone; bar: string } {
  if (!b.healthy) return { label: "liq", title: "Liquidatable", tone: "down", bar: "bg-down" };
  if (Number(b.debt) < 10_000) return { label: "no debt", title: "No debt", tone: "muted", bar: "bg-faint" };
  if (b.ltv > 0.95 * lltv) return { label: "limit", title: "At the limit", tone: "warn", bar: "bg-warn" };
  return { label: "ok", title: "Healthy", tone: "up", bar: "bg-up" };
}

const TH = "py-1.5 font-normal text-faint";

function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <tr className="border-t border-line/60">
      <td colSpan={cols} className="py-3 text-center text-faint">
        {text}
      </td>
    </tr>
  );
}

function Borrowers({ borrowers, lltv }: { borrowers: BorrowerRow[]; lltv: number }) {
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <Label>Borrowers · riskiest first</Label>
        <span className="font-mono text-[10px] text-faint">{borrowers.length}</span>
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-[10px] uppercase">
          <tr>
            <th className={TH}>Address</th>
            <th className={`${TH} text-right`}>Debt</th>
            <th className={`${TH} text-right`}>Coll.</th>
            <th className={`${TH} text-right`}>LTV</th>
            <th className={`${TH} text-right`} />
          </tr>
        </thead>
        <tbody>
          {borrowers.slice(0, BORROWERS_SHOWN).map((b) => {
            const s = borrowerStatus(b, lltv);
            // LTV against the market's LLTV: the bar fills up as the loan nears liquidation
            return (
              <tr key={b.address} className="border-t border-line/60">
                <td className="py-1.5">{shortHash(b.address)}</td>
                <td className="py-1.5 text-right">{usd(b.debt, 2)}</td>
                <td className="py-1.5 text-right text-muted">{nvdax(b.collateral).toFixed(4)}</td>
                <td className="py-1.5">
                  <div className="flex items-center justify-end gap-2" title={`${(b.ltv * 100).toFixed(2)}% of ${(lltv * 100).toFixed(0)}% LLTV`}>
                    <Meter value={b.ltv / lltv} tone={s.bar} className="w-8" />
                    <span>{(b.ltv * 100).toFixed(2)}%</span>
                  </div>
                </td>
                <td className="py-1.5 pl-2 text-right">
                  <Tag tone={s.tone} title={s.title}>
                    {s.label}
                  </Tag>
                </td>
              </tr>
            );
          })}
          {borrowers.length === 0 && <Empty cols={5} text="No open positions" />}
        </tbody>
      </table>
      {borrowers.length > BORROWERS_SHOWN && (
        <p className="mt-1 font-mono text-[10px] text-faint">+{borrowers.length - BORROWERS_SHOWN} more</p>
      )}
    </div>
  );
}

function Liquidations({ market }: { market: MarketSnapshot }) {
  const liquidations = [...(market.liquidations ?? [])].reverse();
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <Label>Liquidations</Label>
        <span className="font-mono text-[10px] text-faint">{liquidations.length}</span>
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-[10px] uppercase">
          <tr>
            <th className={TH}>Op</th>
            <th className={TH}>Borrower</th>
            <th className={`${TH} text-right`}>Repaid</th>
            <th className={`${TH} text-right`}>Seized</th>
            <th className={`${TH} text-right`}>Tx</th>
          </tr>
        </thead>
        <tbody>
          {liquidations.slice(0, LIQUIDATIONS_SHOWN).map((l) => (
            <tr key={l.txHash} className="border-t border-line/60">
              <td className="py-1.5">{l.opId ? <OpBadge id={l.opId} /> : <Tag>{l.by === "naive" ? "naive" : "other"}</Tag>}</td>
              <td className="py-1.5">{shortHash(l.borrower)}</td>
              <td className="py-1.5 text-right">
                {usd(l.repaid, 2)}
                {BigInt(l.badDebt) > 0n && <span className="block text-down">bad debt {usd(l.badDebt, 2)}</span>}
              </td>
              <td className="py-1.5 text-right text-muted">{nvdax(l.seized).toFixed(4)}</td>
              <td className="py-1.5 text-right">
                <TxLink hash={l.txHash} />
              </td>
            </tr>
          ))}
          {liquidations.length === 0 && <Empty cols={5} text="None yet" />}
        </tbody>
      </table>
    </div>
  );
}

export function MarketColumns({ markets }: { markets: MarketSnapshot[] }) {
  return (
    <section className="grid gap-2 lg:grid-cols-3">
      {markets.map((m) => {
        const badDebt = BigInt(m.badDebt) > 0n;
        const borrowers = (m.borrowers ?? []).filter((b) => BigInt(b.debt) > 0n || BigInt(b.collateral) > 0n);
        const open = borrowers.filter((b) => Number(b.debt) >= 10_000);
        const liquidatable = borrowers.filter((b) => !b.healthy).length;
        const collateral = nvdax(m.totalCollateral);
        const t = TITLES[m.name];
        return (
          <Panel
            key={m.name}
            accent={m.name === "C_seiz3"}
            title={
              <>
                <span className="text-foreground">{t.name}</span>
                <Tag tone={t.tone}>{t.tag}</Tag>
              </>
            }
            meta={<span>LLTV {(m.lltv * 100).toFixed(1)}%</span>}
            bodyClassName=""
          >
            <p className="px-3 pt-2.5 text-[12px] text-muted">{LIQUIDATOR[m.name]}</p>
            <div className="grid grid-cols-3 gap-x-3 gap-y-3 px-3 py-3">
              <Stat label="NVDA price" value={price(m.oraclePrice)} />
              <Stat label="Borrowed" value={usd(m.totalBorrow, 2)} />
              <Stat
                label="Collateral"
                value={collateral.toFixed(4)}
                sub={usd(String(Math.round(collateral * m.oraclePrice * 1e6)))}
              />
              <Stat label="Open loans" value={open.length} />
              <Stat label="Liquidatable" value={liquidatable} tone={liquidatable > 0 ? "text-down" : "text-muted"} />
              <Stat label="Bad debt" value={usd(m.badDebt)} tone={badDebt ? "font-semibold text-down" : "text-up"} />
            </div>
            <Borrowers borrowers={borrowers} lltv={m.lltv} />
            <Liquidations market={m} />
          </Panel>
        );
      })}
    </section>
  );
}
