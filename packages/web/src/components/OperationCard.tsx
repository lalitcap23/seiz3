import type { ReactNode } from "react";
import type { HedgeOrder, Operation } from "@seiz3/shared";
import { EVM_NAME, HL_ACCOUNT_URL, HL_EXPLORER_TX } from "@/lib/chain";
import { shortHash, usd } from "@/lib/format";
import { CoreLink, Tag, TxLink } from "./ui";

const nvda = (wei: string) => (Number(wei) / 1e18).toFixed(4);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function OpBadge({ id }: { id: string }) {
  return <Tag tone={id.startsWith("LIQ") ? "evm" : "core"}>{id}</Tag>;
}

export type SoldTo = "buyer" | "pool";

/** Where an unwind's stock went: into the Uniswap v4 curve (the keeper's push), or straight to a buyer (the hook). */
export function SoldToTag({ to }: { to: SoldTo }) {
  return to === "buyer" ? (
    <Tag tone="up" title="Seiz3Hook sold the vault's stock to a buyer at HyperCore's oracle + spread, off the curve">
      → user · hook
    </Tag>
  ) : (
    <Tag tone="evm" title="The keeper's unwindStep sold the vault's stock into the Uniswap v4 pool's curve">
      → AMM
    </Tag>
  );
}

/** The lanes an operation runs through, for the legend above the list. */
export const LANES = [
  { lane: "EVM", tone: "text-evm", text: `${EVM_NAME} tx` },
  { lane: "CORE", tone: "text-core", text: "HyperCore order" },
  { lane: "SYNC", tone: "text-up", text: "hedge confirmed" },
  { lane: "FIFO", tone: "text-muted", text: "whose stock" },
] as const;

/** One line of an operation's trace: which side it happened on, what, and where it opens (`link` overrides `tx`). */
function Step({
  lane,
  tone,
  tx,
  link,
  children,
}: {
  lane: string;
  tone: string;
  tx?: string;
  link?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[2.75rem_1fr_auto] items-baseline gap-2">
      <span className={`font-mono text-[10px] font-semibold ${tone}`}>{lane}</span>
      <span className="min-w-0">{children}</span>
      {link ?? (tx ? <TxLink hash={tx} /> : <span />)}
    </li>
  );
}

/**
 * Where a HyperCore order opens: its fill on Hyperliquid's explorer. An order nothing filled has no fill to show, so
 * it opens the hedge account there (its order history).
 */
function coreLink(o: HedgeOrder): ReactNode {
  const fill = o.fills[0];
  if (fill) return <CoreLink href={`${HL_EXPLORER_TX}${fill.hash}`} label={shortHash(fill.hash)} />;
  return <CoreLink href={HL_ACCOUNT_URL} label="HyperCore" />;
}

const LIMIT_HINT =
  "IOC limit: the worst price this order accepts, and the price Hyperliquid's explorer shows for it. It fills at the " +
  "book's price, which can only be better: higher for a short, lower for a buy-back.";

/**
 * One HyperCore order of the vault, and what Hyperliquid filled. Its limit and its average fill price both show:
 * the explorer leads with the limit, so a card with only the fill price looked like it disagreed with it. One order
 * crossing several makers fills several times in one HyperCore transaction: one link per transaction.
 */
function OrderLine({ o, szDecimals }: { o: HedgeOrder; szDecimals: number }) {
  const unit = 10 ** szDecimals;
  const size = Math.abs(Number(o.delta)) / unit;
  // summed in size units: 0.806 + 0.049 is 0.8550000000000001 in floats
  const filled = Math.round(o.filled * unit) / unit;
  const what = Number(o.delta) < 0 ? `Short ${size.toFixed(szDecimals)} NVDA` : `Buy back ${size.toFixed(szDecimals)} NVDA of short`;
  const txs = [...new Set(o.fills.map((f) => f.hash))];
  const avg = o.avgPx === null ? "" : ` @ $${o.avgPx.toFixed(2)}`;
  return (
    <Step lane="CORE" tone="text-core" link={coreLink(o)}>
      {what}
      {o.tries > 1 ? ` (retry ${o.tries})` : ""}
      {" · "}
      <span className="cursor-help text-muted underline decoration-dotted underline-offset-2" title={LIMIT_HINT}>
        limit ${o.limitPx.toFixed(2)}
      </span>
      {" · "}
      {filled === 0 ? (
        <span className="text-warn">not filled: no order on the book within 1% of the oracle</span>
      ) : filled > size ? (
        // the same cloid placed twice (two relayers at once): the hedge account holds more than the vault asked for
        <span className="text-down" title="HyperCore filled more than the vault asked for: the order was placed twice">
          filled {filled.toFixed(szDecimals)} of {size.toFixed(szDecimals)}{avg} (placed twice)
        </span>
      ) : filled < size ? (
        <span className="text-warn">
          filled {filled.toFixed(szDecimals)} of {size.toFixed(szDecimals)}
          {avg}
        </span>
      ) : (
        <span className="text-up">filled{avg}</span>
      )}
      {txs.map((hash) => {
        const n = o.fills.filter((f) => f.hash === hash).length;
        return (
          <a
            key={hash}
            href={`${HL_EXPLORER_TX}${hash}`}
            target="_blank"
            rel="noreferrer"
            className="ml-2 font-mono text-[10px] text-faint hover:text-foreground"
          >
            {n > 1 ? `${n} fills` : "fill"} {shortHash(hash)} ↗
          </a>
        );
      })}
    </Step>
  );
}

function Lots({ lots }: { lots: Operation["lots"] }) {
  return lots.map((l, i) => (
    <span key={l.opId} className="inline-flex items-center gap-1">
      {i > 0 ? ", " : ""}
      <OpBadge id={l.opId} /> <span className="font-mono">{nvda(l.nvdax)}</span>
    </span>
  ));
}

/**
 * A liquidation or an unwind, end to end: what the vault did on Base, the HyperCore orders that hedged it, the
 * sync that confirmed it, and (first in, first out) which unwinds sold this liquidation's stock, or whose stock an
 * unwind sold.
 */
export function OperationCard({ op, szDecimals, me }: { op: Operation; szDecimals: number; me?: string | null }) {
  const liq = op.kind === "liquidation";
  const mine = me && op.borrower?.toLowerCase() === me.toLowerCase();
  const held = BigInt(op.held);
  return (
    <article className={`px-3 py-2.5 ${mine ? "bg-brand/[0.03] shadow-[inset_2px_0_0_var(--color-brand)]" : ""}`}>
      <header className="mb-1.5 flex flex-wrap items-center gap-2">
        <OpBadge id={op.id} />
        <span className="text-[12px] font-medium">{liq ? "Liquidation" : "Unwind"}</span>
        {!liq && op.soldTo && <SoldToTag to={op.soldTo} />}
        {liq && op.borrower && (
          <span className="font-mono text-[11px] text-muted">
            {mine ? "your loan" : short(op.borrower)} · Market C
          </span>
        )}
        {op.timestamp > 0 && (
          <span className="ml-auto font-mono text-[11px] text-faint" suppressHydrationWarning>
            {new Date(op.timestamp).toLocaleString([], { hour12: false })}
          </span>
        )}
      </header>
      <ol className="flex flex-col gap-1 text-[12px]">
        {op.id === "LIQ-0" ? (
          <Step lane="HELD" tone="text-muted">
            <span className="text-muted">
              {nvda(op.nvdax)} NVDAx the vault already held when this feed started (earlier liquidations).
            </span>
          </Step>
        ) : (
          <Step lane="EVM" tone="text-evm" tx={op.txHash}>
            {liq
              ? `Bought ${nvda(op.nvdax)} NVDAx of collateral from Morpho, repaying ${usd(op.usdc, 2)} of debt`
              : op.soldTo === "buyer"
                ? `A buyer took ${nvda(op.nvdax)} NVDAx straight from the vault through the v4 hook for ${usd(op.usdc, 2)}`
                : `Sold ${nvda(op.nvdax)} NVDAx into the Uniswap v4 pool (AMM curve) for ${usd(op.usdc, 2)}`}
          </Step>
        )}
        {op.orders.map((o) => (
          <OrderLine key={o.cloid} o={o} szDecimals={szDecimals} />
        ))}
        {op.id !== "LIQ-0" &&
          (op.confirmed ? (
            <Step lane="SYNC" tone="text-up" tx={op.confirmed.txHash}>
              syncHedge read the short back: {(Math.abs(Number(op.confirmed.actual)) / 10 ** szDecimals).toFixed(3)} NVDA
            </Step>
          ) : (
            <Step lane="SYNC" tone="text-warn">
              <span className="text-warn">Waiting for syncHedge to confirm on HyperCore…</span>
            </Step>
          ))}
        <Step lane="FIFO" tone="text-muted">
          <span className="text-muted">
            {liq ? (
              <>
                {op.lots.length === 0 ? "Not unwound yet. " : "Unwound by "}
                <Lots lots={op.lots} />
                {op.lots.length > 0 ? ". " : ""}
                {held > 0n ? (
                  <>
                    Still held, hedged: <span className="font-mono text-foreground">{nvda(op.held)}</span> NVDAx.
                  </>
                ) : (
                  "Fully unwound."
                )}
              </>
            ) : (
              <>
                Sold the stock of <Lots lots={op.lots} />
              </>
            )}
          </span>
        </Step>
      </ol>
    </article>
  );
}
