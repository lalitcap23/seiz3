import type { ReactNode } from "react";
import type { Snapshot } from "@afterbell/shared";
import { nvdax, price, signedPct } from "@/lib/format";
import { Label, Tag, type Tone } from "./ui";

/** The vault won't sell into a pool more than this far from HyperCore's price (RiskParams.oracleBandBps). */
const BAND = 0.015;

const drained = (pool: number, oracle: number) => oracle > 0 && pool < oracle / 2;

function Cell({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`flex shrink-0 flex-col justify-center gap-1 border-r border-line px-4 py-2 last:border-r-0 ${className}`}>
      <Label>{label}</Label>
      <div className="flex items-center gap-2 font-mono text-[13px]">{children}</div>
    </div>
  );
}

/** Where the weekend story stands: market closed or open, and whether the pool is a place the vault can sell into. */
export function StatusBar({ data }: { data: Snapshot }) {
  const oracle = data.hyperliquid?.oraclePx ?? 0;
  const gap = oracle > 0 ? data.pool.price / oracle - 1 : 0;
  const holding = BigInt(data.vault.inventory) > 0n;
  // testnet: market A dumps into its own thin pool, and the vault's pool stays deep
  const thin = data.thinPool;
  const pool: { text: string; tone: Tone; title?: string } =
    !thin && drained(data.pool.price, oracle)
      ? { text: "drained", tone: "down", title: "thin pool drained" }
      : holding && Math.abs(gap) > BAND
        ? { text: "holding", tone: "warn", title: "off HyperCore: the vault holds, hedged, and waits for buyers" }
        : { text: "in band", tone: "muted", title: "in line with HyperCore" };
  const thinGap = thin && oracle > 0 ? thin.price / oracle - 1 : 0;

  return (
    <section className="flex items-stretch overflow-x-auto rounded-[3px] border border-line bg-panel">
      <Cell label="Session">
        <Tag tone={data.marketOpen ? "up" : "warn"}>{data.marketOpen ? "Monday · market open" : "Weekend · market closed"}</Tag>
      </Cell>
      <Cell label="NVDA · HyperCore oracle">
        <span className="text-[15px] font-medium">{oracle > 0 ? price(oracle) : "–"}</span>
      </Cell>
      <Cell label={thin ? "Vault's v4 pool" : "Uniswap v4 pool"}>
        <span className="text-[15px] font-medium">{price(data.pool.price)}</span>
        {oracle > 0 && <span className={Math.abs(gap) > BAND ? "text-warn" : "text-faint"}>{signedPct(gap)}</span>}
        <Tag tone={pool.tone} title={pool.title}>
          {pool.text}
        </Tag>
      </Cell>
      {thin && (
        <Cell label="Market A's weekend pool">
          <span className="text-[15px] font-medium">{price(thin.price)}</span>
          {oracle > 0 && <span className={Math.abs(thinGap) > BAND ? "text-down" : "text-faint"}>{signedPct(thinGap)}</span>}
          {drained(thin.price, oracle) && (
            <Tag tone="down" title="thin pool drained">
              drained
            </Tag>
          )}
        </Cell>
      )}
      {data.hook && (
        <Cell label="Vault's ask · v4 hook">
          <span className="text-[15px] font-medium">{price(data.hook.ask)}</span>
          <Tag
            tone={data.hook.open ? "muted" : "warn"}
            title="LP fee the hook sets for curve swaps: wide after the bell, tight while the market is open"
          >
            {data.hook.open ? "market fee" : "after-hours fee"} {(data.hook.fee / 10_000).toFixed(2)}%
          </Tag>
          {BigInt(data.hook.capacity) > 0n ? (
            <span className="text-up" title="what one buy can take from the vault's hedged stock right now">
              {nvdax(data.hook.capacity).toFixed(3)} for sale
            </span>
          ) : (
            holding && (
              <span
                className="text-faint"
                title="fills wait for the last buy-back to confirm, or for the pool to trade at or above the ask"
              >
                waiting
              </span>
            )
          )}
        </Cell>
      )}
      <Cell label="Unwind band">
        <span className="text-muted">±{(BAND * 100).toFixed(1)}%</span>
      </Cell>
      {/* prerendered in the server's timezone, shown in the viewer's */}
      <Cell label="Updated" className="ml-auto border-l border-r-0">
        <span className="text-muted" suppressHydrationWarning>
          {new Date(data.updatedAt).toLocaleTimeString([], { hour12: false })}
        </span>
      </Cell>
    </section>
  );
}
