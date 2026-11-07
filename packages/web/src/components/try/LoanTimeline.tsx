"use client";

import type { Operation } from "@seiz3/shared";
import { OperationCard } from "../OperationCard";
import { Label, Panel } from "../ui";

/** What has to hold at once before the vault sells stock into the pool (RiskParams); otherwise it waits, hedged. */
const GATES = [
  ["1.5%", "pool within this of HyperCore"],
  ["0.5%", "most one chunk may move the pool"],
  ["1%", "sale must pay within this of HyperCore"],
  ["seller", "on HyperCore for the buy-back"],
] as const;

function Gates() {
  return (
    <div className="ml-6 flex flex-col gap-2 border-l border-line py-2.5 pr-3 pl-3">
      <p className="text-[12px] text-muted">
        Not unwound yet: the vault holds the stock, hedged, until every rule passes at once. Otherwise it waits, if need be
        until the stock market opens.
      </p>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-line bg-line md:grid-cols-4">
        {GATES.map(([value, text]) => (
          <div key={text} className="flex flex-col gap-0.5 bg-well px-2.5 py-2">
            <span className="font-mono text-[13px]">{value}</span>
            <span className="text-[11px] text-faint">{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Your liquidations (LIQ-n), newest first, each with the short that hedged it on HyperCore, the sync that confirmed
 * it, and the unwinds (UNW-n) that later sold that stock, first in, first out.
 */
export function LoanTimeline({ operations, address, szDecimals }: { operations: Operation[]; address: string; szDecimals: number }) {
  const mine = operations.filter((o) => o.kind === "liquidation" && o.borrower?.toLowerCase() === address.toLowerCase());
  if (mine.length === 0) return null;
  const byId = new Map(operations.map((o) => [o.id, o]));
  return (
    <Panel
      title={<span className="text-brand">What happened to your loan</span>}
      meta={<span>{mine.length} liquidation{mine.length === 1 ? "" : "s"}</span>}
      bodyClassName="flex flex-col divide-y divide-line"
    >
      {[...mine].reverse().map((liq) => (
        <div key={liq.id} className="flex flex-col pb-1">
          <OperationCard op={liq} szDecimals={szDecimals} me={address} />
          {liq.lots.map((l) => {
            const unwind = byId.get(l.opId);
            return unwind ? (
              <div key={l.opId} className="ml-6 border-l border-line">
                <Label className="block px-3 pt-2 text-faint">sold by</Label>
                <OperationCard op={unwind} szDecimals={szDecimals} />
              </div>
            ) : null;
          })}
          {liq.lots.length === 0 && <Gates />}
        </div>
      ))}
    </Panel>
  );
}
