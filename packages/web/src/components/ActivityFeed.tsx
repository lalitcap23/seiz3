import type { ActivityEvent } from "@seiz3/shared";
import { coreSize, nvdax, price, usd } from "@/lib/format";
import { OpBadge, SoldToTag, type SoldTo } from "./OperationCard";
import { Panel, TxLink } from "./ui";

const SHOWN = 12;

/**
 * One vault event in words: what happened, and on which side (HyperEVM or HyperCore). `soldTo` says where an
 * Unwound's stock went, when known: the hook's InventoryFill in the same transaction means a buyer, otherwise the curve.
 */
export function describe(
  e: Pick<ActivityEvent, "type" | "args">,
  szDecimals: number,
  soldTo?: SoldTo,
): { text: string; tone: string } {
  const a = e.args as Record<string, string | boolean | number>;
  const size = (v: unknown) => Math.abs(coreSize(String(v), szDecimals)).toFixed(3);
  switch (e.type) {
    case "LiquidationTaken":
      return { text: `Liquidated: bought ${nvdax(String(a.seized)).toFixed(4)} NVDAx, repaid ${usd(String(a.repaid), 2)} to lenders`, tone: "text-evm" };
    case "HedgeSent":
      return Number(a.delta) < 0
        ? { text: `Short ${size(a.delta)} NVDA sent to HyperCore${Number(a.tries) > 1 ? ` (retry ${a.tries})` : ""}`, tone: "text-core" }
        : { text: `Buy-back ${size(a.delta)} NVDA sent to HyperCore (reduce-only)`, tone: "text-core" };
    case "HedgeConfirmed":
      return Number(a.actual) === 0
        ? { text: "Hedge confirmed: flat on HyperCore, the short is closed", tone: "text-up" }
        : { text: `Hedge confirmed: short ${size(a.actual)} NVDA on HyperCore`, tone: "text-up" };
    case "HedgeStuck":
      return { text: `Hedge stuck: ${size(a.gap)} NVDA unfilled, vault paused`, tone: "text-down" };
    case "Unwound":
      return soldTo === "buyer"
        ? { text: `Sold ${nvdax(String(a.chunk)).toFixed(4)} NVDAx to a buyer through the v4 hook for ${usd(String(a.usdcOut), 2)}`, tone: "text-up" }
        : soldTo === "pool"
          ? { text: `Sold ${nvdax(String(a.chunk)).toFixed(4)} NVDAx into the Uniswap v4 pool (AMM curve) for ${usd(String(a.usdcOut), 2)}`, tone: "text-evm" }
          : { text: `Sold ${nvdax(String(a.chunk)).toFixed(4)} NVDAx on Uniswap v4 for ${usd(String(a.usdcOut), 2)}`, tone: "text-evm" };
    case "MarginMoved":
      return { text: `${usd(String(a.amount), 2)} margin ${a.toCore ? "to" : "back from"} HyperCore`, tone: "text-muted" };
    case "InventoryFill":
      return {
        text: `A buyer took ${nvdax(String(a.nvdaxOut)).toFixed(4)} NVDAx from the vault at ${price(Number(a.ask) / 1e6)} (v4 hook${a.marketOpen ? "" : ", after hours"})`,
        tone: "text-up",
      };
  }
}

const KIND: Record<ActivityEvent["type"], string> = {
  LiquidationTaken: "liquidate",
  HedgeSent: "hedge",
  HedgeConfirmed: "confirm",
  HedgeStuck: "stuck",
  Unwound: "unwind",
  MarginMoved: "margin",
  InventoryFill: "unwind", // a sale too: the hook's, to a buyer
};

export function ActivityFeed({
  events,
  szDecimals,
  className = "",
}: {
  events: ActivityEvent[];
  szDecimals: number;
  className?: string;
}) {
  // a hook fill emits the hook's InventoryFill and the vault's Unwound in one transaction: one row for it, the fill's
  // (it carries the ask), tagged as a sale to a user; every other Unwound is a keeper push into the curve
  const fillTxs = new Set(events.filter((e) => e.type === "InventoryFill").map((e) => e.txHash));
  const rows = events.filter((e) => !(e.type === "Unwound" && fillTxs.has(e.txHash)));
  const soldTo = (e: ActivityEvent): SoldTo | undefined =>
    e.type === "InventoryFill" ? "buyer" : e.type === "Unwound" ? "pool" : undefined;
  const latest = rows.slice(-SHOWN).reverse();
  return (
    <Panel title="Vault activity" meta={<span>last {SHOWN}</span>} className={className} bodyClassName="flex flex-col">
      <div className="hidden grid-cols-[4rem_3.5rem_4.5rem_1fr_auto] gap-2 border-b border-line px-3 py-1.5 font-mono text-[10px] uppercase text-faint sm:grid">
        <span>Time</span>
        <span>Op</span>
        <span>Event</span>
        <span>Detail</span>
        <span>Tx</span>
      </div>
      {latest.length === 0 && <p className="px-3 py-6 text-center font-mono text-[12px] text-faint">Nothing yet</p>}
      <ol className="flex flex-col overflow-y-auto lg:max-h-[620px]">
        {latest.map((e, i) => {
          const to = soldTo(e);
          const d = describe(e, szDecimals, to);
          return (
            <li
              key={`${e.txHash}-${e.type}-${rows.length - i}`}
              className="grid grid-cols-[4rem_1fr_auto] items-baseline gap-x-2 gap-y-1 border-b border-line/60 px-3 py-[7px] last:border-b-0 hover:bg-raised sm:grid-cols-[4rem_3.5rem_4.5rem_1fr_auto]"
            >
              <span className="font-mono text-[11px] text-faint" suppressHydrationWarning>
                {new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}
              </span>
              {/* phone: op and event share a cell, the detail goes on its own line below */}
              <span className="flex items-baseline gap-2 sm:contents">
                <span>{e.opId && <OpBadge id={e.opId} />}</span>
                <span className={`font-mono text-[10px] font-semibold uppercase ${d.tone}`}>{KIND[e.type]}</span>
              </span>
              <span className="col-span-2 col-start-2 min-w-0 text-[12px] sm:col-span-1 sm:col-start-auto">
                {to && (
                  <span className="mr-1.5 inline-block align-middle">
                    <SoldToTag to={to} />
                  </span>
                )}
                {d.text}
              </span>
              <TxLink hash={e.txHash} className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto" />
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
