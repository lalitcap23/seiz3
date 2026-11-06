import type { Operation } from "@afterbell/shared";
import { LANES, OperationCard, SoldToTag } from "./OperationCard";
import { Panel } from "./ui";

const SHOWN = 12;

/** Every liquidation and unwind, newest first; LIQ-0 (stock from before the feed) last while any of it is held. */
export function Operations({
  operations,
  szDecimals,
  className = "",
}: {
  operations: Operation[];
  szDecimals: number;
  className?: string;
}) {
  const zero = operations.find((o) => o.id === "LIQ-0" && BigInt(o.held) > 0n);
  const latest = operations.filter((o) => o.id !== "LIQ-0").slice(-SHOWN).reverse();
  return (
    <Panel
      title="Liquidations & unwinds"
      meta={<span>{latest.length} shown · FIFO</span>}
      className={className}
      bodyClassName="flex flex-col"
    >
      {/* each one end to end: the HyperEVM tx, the HyperCore orders that hedged it, the sync that confirmed it, and
          which unwinds sold whose stock (first in, first out) */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-3 py-1.5 font-mono text-[10px] text-faint">
        {LANES.map((l) => (
          <span key={l.lane}>
            <span className={`font-semibold ${l.tone}`}>{l.lane}</span> {l.text}
          </span>
        ))}
      </div>
      {/* the two ways an unwind's stock leaves the vault */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-1.5 font-mono text-[10px] text-faint">
        <span className="inline-flex items-center gap-1.5">
          <SoldToTag to="pool" /> keeper sold into the curve
        </span>
        <span className="inline-flex items-center gap-1.5">
          <SoldToTag to="buyer" /> the hook sold to a buyer, off the curve
        </span>
      </div>
      {latest.length === 0 && !zero && <p className="px-3 py-6 text-center font-mono text-[12px] text-faint">Nothing yet</p>}
      <div className="flex flex-col divide-y divide-line overflow-y-auto lg:max-h-[620px]">
        {latest.map((op) => (
          <OperationCard key={op.id} op={op} szDecimals={szDecimals} />
        ))}
        {zero && <OperationCard op={zero} szDecimals={szDecimals} />}
      </div>
    </Panel>
  );
}
