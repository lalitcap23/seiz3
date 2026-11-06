"use client";

import type { Operation } from "@afterbell/shared";
import { OperationCard } from "../OperationCard";

/**
 * Your liquidations (LIQ-n), newest first, each with the short that hedged it on HyperCore, the sync that confirmed
 * it, and the unwinds (UNW-n) that later sold that stock, first in, first out.
 */
export function LoanTimeline({ operations, address, szDecimals }: { operations: Operation[]; address: string; szDecimals: number }) {
  const mine = operations.filter((o) => o.kind === "liquidation" && o.borrower?.toLowerCase() === address.toLowerCase());
  if (mine.length === 0) return null;
  const byId = new Map(operations.map((o) => [o.id, o]));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-emerald-500">What happened to your loan</p>
      {[...mine].reverse().map((liq) => (
        <div key={liq.id} className="flex flex-col gap-1.5">
          <OperationCard op={liq} szDecimals={szDecimals} me={address} />
          {liq.lots.map((l) => {
            const unwind = byId.get(l.opId);
            return unwind ? (
              <div key={l.opId} className="ml-4">
                <OperationCard op={unwind} szDecimals={szDecimals} />
              </div>
            ) : null;
          })}
          {liq.lots.length === 0 && (
            <p className="ml-4 text-xs opacity-60">
              Not unwound yet: the vault holds the stock, hedged, until every rule passes at once. The pool must be within
              1.5% of HyperCore, a chunk can move it at most 0.5%, the sale must pay within 1% of HyperCore&apos;s price,
              and HyperCore must have a seller for the buy-back. Otherwise it waits, if need be until the stock market
              opens.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
