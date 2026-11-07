import type { HyperliquidPanel as Position } from "@seiz3/shared";
import { price } from "@/lib/format";
import { KV, Label, Panel, Tag } from "./ui";

export function HyperliquidPanel({ data, className = "" }: { data: Position | null; className?: string }) {
  if (!data) {
    return (
      <Panel title="HyperCore position" meta={<Tag tone="warn">stale</Tag>} className={className}>
        <p className="font-mono text-[12px] text-warn">Hyperliquid data stale</p>
      </Panel>
    );
  }
  const side = data.size === 0 ? null : data.size < 0 ? "short" : "long";
  return (
    <Panel
      title={`HyperCore · ${data.coin}`}
      meta={
        data.explorerUrl ? (
          <a href={data.explorerUrl} target="_blank" rel="noreferrer" className="hover:text-foreground">
            explorer ↗
          </a>
        ) : (
          <span>local HyperCore</span>
        )
      }
      className={className}
    >
      <div className="mb-2 flex items-end justify-between border-b border-line pb-3">
        <div className="flex flex-col gap-1">
          <Label>Position</Label>
          <p className="font-mono text-[22px] leading-none font-semibold">
            {side === null ? <span className="text-muted">flat</span> : `${Math.abs(data.size)} NVDA`}
          </p>
        </div>
        {side && <Tag tone={side === "short" ? "down" : "up"}>{side}</Tag>}
      </div>
      <KV
        rows={[
          ["Entry", data.entryPx === null ? "–" : price(data.entryPx)],
          ["Oracle", price(data.oraclePx)],
          ["Mark", price(data.markPx)],
          [
            "Unrealised PnL",
            <span key="pnl" className={data.unrealizedPnl >= 0 ? "text-up" : "text-down"}>
              {data.unrealizedPnl > 0 ? "+" : ""}
              {price(data.unrealizedPnl)}
            </span>,
          ],
          ["Margin used", price(data.marginUsed)],
          ["Account value", price(data.accountValue)],
        ]}
      />
    </Panel>
  );
}
