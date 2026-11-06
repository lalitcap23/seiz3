import type { ActivityEvent } from "@afterbell/shared";
import Link from "next/link";
import { coreSize, nvdax, shortHash, usd } from "@/lib/format";

const SHOWN = 12;

/** One vault event in words: what happened, and on which side (HyperEVM or HyperCore). */
export function describe(e: Pick<ActivityEvent, "type" | "args">, szDecimals: number): { text: string; tone: string } {
  const a = e.args as Record<string, string | boolean | number>;
  const size = (v: unknown) => Math.abs(coreSize(String(v), szDecimals)).toFixed(3);
  switch (e.type) {
    case "LiquidationTaken":
      return { text: `Liquidated: bought ${nvdax(String(a.seized)).toFixed(3)} NVDAx, repaid ${usd(String(a.repaid))} to lenders`, tone: "text-sky-500" };
    case "HedgeSent":
      return Number(a.delta) < 0
        ? { text: `Short ${size(a.delta)} NVDA sent to HyperCore${Number(a.tries) > 1 ? ` (retry ${a.tries})` : ""}`, tone: "text-violet-500" }
        : { text: `Buy-back ${size(a.delta)} NVDA sent to HyperCore (reduce-only)`, tone: "text-violet-500" };
    case "HedgeConfirmed":
      return Number(a.actual) === 0
        ? { text: "Hedge confirmed: flat on HyperCore, the short is closed", tone: "text-emerald-500" }
        : { text: `Hedge confirmed: short ${size(a.actual)} NVDA on HyperCore`, tone: "text-emerald-500" };
    case "HedgeStuck":
      return { text: `Hedge stuck: ${size(a.gap)} NVDA unfilled, vault paused`, tone: "text-red-500" };
    case "Unwound":
      return { text: `Sold ${nvdax(String(a.chunk)).toFixed(3)} NVDAx into Uniswap v4 for ${usd(String(a.usdcOut))}`, tone: "text-sky-500" };
    case "MarginMoved":
      return { text: `${usd(String(a.amount))} margin ${a.toCore ? "to" : "back from"} HyperCore`, tone: "opacity-70" };
  }
}

export function ActivityFeed({ events, szDecimals }: { events: ActivityEvent[]; szDecimals: number }) {
  const latest = events.slice(-SHOWN).reverse();
  return (
    <section className="rounded-xl border border-foreground/10 p-4">
      <h2 className="text-sm font-semibold">Vault activity</h2>
      {latest.length === 0 && <p className="mt-3 text-sm opacity-60">Nothing yet</p>}
      <ol className="mt-3 flex flex-col gap-1.5 text-sm">
        {latest.map((e, i) => {
          const d = describe(e, szDecimals);
          return (
            <li key={`${e.txHash}-${e.type}-${events.length - i}`} className="flex gap-3">
              <span className="w-16 shrink-0 tabular-nums opacity-50" suppressHydrationWarning>{new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}</span>
              <span className={d.tone}>{d.text}</span>
              <Link href={`/tx/${e.txHash}`} className="ml-auto shrink-0 font-mono text-xs underline opacity-50 hover:opacity-100">
                {shortHash(e.txHash)}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
