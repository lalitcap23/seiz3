import Link from "next/link";
import type { HedgeOrder, Operation } from "@afterbell/shared";
import { HL_EXPLORER_TX } from "@/lib/chain";
import { shortHash, usd } from "@/lib/format";

const nvda = (wei: string) => (Number(wei) / 1e18).toFixed(4);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function OpBadge({ id }: { id: string }) {
  const liq = id.startsWith("LIQ");
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
        liq ? "bg-sky-500/15 text-sky-500" : "bg-violet-500/15 text-violet-500"
      }`}
    >
      {id}
    </span>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <Link href={`/tx/${hash}`} className="ml-auto shrink-0 font-mono text-[11px] underline opacity-50 hover:opacity-100">
      {shortHash(hash)}
    </Link>
  );
}

/** One HyperCore order of the vault, and what Hyperliquid filled (each fill opens on Hyperliquid's explorer). */
function OrderLine({ o, szDecimals }: { o: HedgeOrder; szDecimals: number }) {
  const size = Math.abs(Number(o.delta)) / 10 ** szDecimals;
  const what = Number(o.delta) < 0 ? `Short ${size.toFixed(3)} NVDA` : `Buy back ${size.toFixed(3)} NVDA of short`;
  const full = o.filled + 1e-9 >= size;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-violet-500">HyperCore</span>
      <span>
        {what}
        {o.tries > 1 ? ` (retry ${o.tries})` : ""}:{" "}
        {o.filled === 0 ? (
          <span className="text-amber-500">not filled (no order on the book within 1% of the oracle)</span>
        ) : (
          <span className={full ? "text-emerald-500" : "text-amber-500"}>
            {full ? "filled" : `filled ${o.filled.toFixed(3)}`} @ ${o.avgPx?.toFixed(2)}
          </span>
        )}
      </span>
      {o.fills.map((f) => (
        <a key={f.hash} href={`${HL_EXPLORER_TX}${f.hash}`} target="_blank" rel="noreferrer" className="font-mono text-[11px] underline opacity-50 hover:opacity-100">
          fill {shortHash(f.hash)} ↗
        </a>
      ))}
      <TxLink hash={o.txHash} />
    </li>
  );
}

/**
 * A liquidation or an unwind, end to end: what the vault did on HyperEVM, the HyperCore orders that hedged it, the
 * sync that confirmed it, and (first in, first out) which unwinds sold this liquidation's stock, or whose stock an
 * unwind sold.
 */
export function OperationCard({ op, szDecimals, me }: { op: Operation; szDecimals: number; me?: string | null }) {
  const liq = op.kind === "liquidation";
  const mine = me && op.borrower?.toLowerCase() === me.toLowerCase();
  const held = BigInt(op.held);
  return (
    <article className={`rounded-lg border p-3 text-xs ${mine ? "border-emerald-500/50" : "border-foreground/10"}`}>
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <OpBadge id={op.id} />
        <span className="font-semibold">{liq ? "Liquidation" : "Unwind"}</span>
        {liq && op.borrower && (
          <span className="opacity-70">
            of {mine ? "your loan" : short(op.borrower)} · Market C
          </span>
        )}
        {op.timestamp > 0 && (
          <span className="ml-auto tabular-nums opacity-50" suppressHydrationWarning>
            {new Date(op.timestamp).toLocaleString([], { hour12: false })}
          </span>
        )}
      </header>
      <ol className="flex flex-col gap-1">
        {op.id === "LIQ-0" ? (
          <li className="opacity-70">
            {nvda(op.nvdax)} NVDAx the vault already held when this feed started (earlier liquidations).
          </li>
        ) : (
          <li className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sky-500">HyperEVM</span>
            <span>
              {liq
                ? `Bought ${nvda(op.nvdax)} NVDAx of collateral from Morpho, repaying ${usd(op.usdc, 2)} of debt`
                : `Sold ${nvda(op.nvdax)} NVDAx into Uniswap v4 for ${usd(op.usdc, 2)}`}
            </span>
            <TxLink hash={op.txHash} />
          </li>
        )}
        {op.orders.map((o) => (
          <OrderLine key={o.cloid} o={o} szDecimals={szDecimals} />
        ))}
        {op.id !== "LIQ-0" &&
          (op.confirmed ? (
            <li className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-emerald-500">Confirmed</span>
              <span>syncHedge read the short back: {(Math.abs(Number(op.confirmed.actual)) / 10 ** szDecimals).toFixed(3)} NVDA</span>
              <TxLink hash={op.confirmed.txHash} />
            </li>
          ) : (
            <li className="opacity-60">Waiting for syncHedge to confirm on HyperCore…</li>
          ))}
        {liq ? (
          <li className="opacity-80">
            {op.lots.length === 0 ? "Not unwound yet. " : "Unwound by "}
            {op.lots.map((l, i) => (
              <span key={l.opId}>
                {i > 0 ? ", " : ""}
                <OpBadge id={l.opId} /> {nvda(l.nvdax)}
              </span>
            ))}
            {op.lots.length > 0 ? ". " : ""}
            {held > 0n ? `Still held, hedged: ${nvda(op.held)} NVDAx.` : "Fully unwound."}
          </li>
        ) : (
          <li className="opacity-80">
            Sold the stock of{" "}
            {op.lots.map((l, i) => (
              <span key={l.opId}>
                {i > 0 ? ", " : ""}
                <OpBadge id={l.opId} /> {nvda(l.nvdax)}
              </span>
            ))}
          </li>
        )}
      </ol>
    </article>
  );
}
