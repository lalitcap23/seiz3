import type { Operation } from "@afterbell/shared";
import { OperationCard } from "./OperationCard";

const SHOWN = 12;

/** Every liquidation and unwind, newest first; LIQ-0 (stock from before the feed) last while any of it is held. */
export function Operations({ operations, szDecimals }: { operations: Operation[]; szDecimals: number }) {
  const zero = operations.find((o) => o.id === "LIQ-0" && BigInt(o.held) > 0n);
  const latest = operations.filter((o) => o.id !== "LIQ-0").slice(-SHOWN).reverse();
  return (
    <section className="rounded-xl border border-foreground/10 p-4">
      <h2 className="text-sm font-semibold">Liquidations &amp; unwinds</h2>
      <p className="mb-3 text-xs opacity-60">
        Each one end to end: the HyperEVM transaction, the HyperCore orders that hedged it, the sync that confirmed it,
        and which unwinds sold whose stock (first in, first out).
      </p>
      {latest.length === 0 && !zero && <p className="text-sm opacity-60">Nothing yet</p>}
      <div className="flex flex-col gap-2">
        {latest.map((op) => (
          <OperationCard key={op.id} op={op} szDecimals={szDecimals} />
        ))}
        {zero && <OperationCard op={zero} szDecimals={szDecimals} />}
      </div>
    </section>
  );
}
