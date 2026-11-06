"use client";

import type { ActivityEvent } from "@afterbell/shared";
import { EXPLORER_TX } from "@/lib/chain";
import { shortHash } from "@/lib/format";
import { describe } from "../ActivityFeed";

function Step({ e, szDecimals }: { e: ActivityEvent; szDecimals: number }) {
  const d = describe(e, szDecimals);
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="w-14 shrink-0 tabular-nums opacity-50" suppressHydrationWarning>
        {new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}
      </span>
      <span className={d.tone}>{d.text}</span>
      <a className="ml-auto font-mono underline opacity-60" href={`${EXPLORER_TX}${e.txHash}`} target="_blank" rel="noreferrer">
        {shortHash(e.txHash)}
      </a>
    </li>
  );
}

/**
 * Each liquidation of this address, end to end: the vault buys the collateral and shorts it on HyperCore in one tx,
 * `syncHedge` confirms the short, and the unwinds that followed sell stock into Uniswap and buy the short back.
 * Unwinds are vault-wide (chunks of everything it holds), so they're listed from the liquidation on.
 */
export function LoanTimeline({ activity, address, szDecimals }: { activity: ActivityEvent[]; address: string; szDecimals: number }) {
  const mine = activity.filter(
    (e) => e.type === "LiquidationTaken" && String(e.args.borrower).toLowerCase() === address.toLowerCase(),
  );
  if (mine.length === 0) return null;
  const last = mine[mine.length - 1]!;
  const sameTx = activity.filter((e) => e.txHash === last.txHash && e.type === "HedgeSent");
  const after = activity.filter((e) => e.timestamp >= last.timestamp && e.txHash !== last.txHash);
  const confirmed = after.find((e) => e.type === "HedgeConfirmed");
  const unwinds = after.filter((e) => e.type === "Unwound" || (e.type === "HedgeSent" && Number(e.args.delta) > 0));

  return (
    <div className="rounded-lg bg-emerald-500/10 p-3 text-xs">
      <p className="mb-2 font-medium text-emerald-500">What happened to your loan</p>
      <ol className="flex flex-col gap-1">
        <Step e={last} szDecimals={szDecimals} />
        {sameTx.map((e) => (
          <Step key={`${e.txHash}-short`} e={e} szDecimals={szDecimals} />
        ))}
        {confirmed ? <Step e={confirmed} szDecimals={szDecimals} /> : <li className="opacity-60">Waiting for syncHedge to confirm the short on HyperCore…</li>}
        {unwinds.map((e, i) => (
          <Step key={`${e.txHash}-${e.type}-${i}`} e={e} szDecimals={szDecimals} />
        ))}
      </ol>
      {unwinds.length === 0 && (
        <p className="mt-2 opacity-70">
          No unwind yet: the vault holds the stock, hedged, until every rule passes at once. The Uniswap pool is within
          1.5% of HyperCore, a chunk moves it under 0.5%, it pays within 1% of HyperCore&apos;s price, and HyperCore has a
          seller for the buy-back. Otherwise it waits, if need be until the stock market opens.
        </p>
      )}
      {mine.length > 1 && <p className="mt-2 opacity-60">Liquidated {mine.length} times; showing the latest.</p>}
    </div>
  );
}
