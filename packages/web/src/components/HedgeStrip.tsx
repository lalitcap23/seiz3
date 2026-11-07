"use client";

import type { VaultSnapshot } from "@seiz3/shared";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import { useHistory } from "@/lib/api";
import { coreSize, nvdax, usd } from "@/lib/format";
import { Label, Panel, Stat, Tag, type Tone } from "./ui";

const STATE: Record<VaultSnapshot["hedgeState"], { text: string; tag: string; tone: Tone }> = {
  Idle: { text: "hedged", tag: "hedged", tone: "up" },
  Pending: { text: "hedge in flight: waiting for syncHedge", tag: "pending", tone: "warn" },
  Retrying: { text: "retrying the hedge", tag: "retrying", tone: "warn" },
  Paused: { text: "paused", tag: "paused", tone: "down" },
};

const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  brand: "text-brand",
  evm: "text-evm",
  core: "text-core",
  muted: "text-muted",
};

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr_4.5rem] items-center gap-3">
      <span className="text-[12px] text-muted">{label}</span>
      <div className="h-1.5 rounded-full bg-line-strong">
        <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${max === 0 ? 0 : (100 * value) / max}%` }} />
      </div>
      <span className="text-right font-mono text-[12px]">{value.toFixed(3)}</span>
    </div>
  );
}

/** Hero number: hedge ratio. Should dip to 0% after the click, then snap to 100% when syncHedge lands. */
export function HedgeStrip({
  vault,
  coreShort,
  className = "",
}: {
  vault: VaultSnapshot;
  coreShort: number | null;
  className?: string;
}) {
  const { data: history = [] } = useHistory();
  const pct = Math.round(vault.hedgeRatio * 100);
  const state = vault.paused ? STATE.Paused : STATE[vault.hedgeState];
  const held = nvdax(vault.inventory);
  const confirmed = Math.abs(coreSize(vault.confirmedShort, vault.szDecimals));
  const live = Math.abs(coreShort ?? 0);
  const max = Math.max(held, confirmed, live);

  return (
    <Panel
      title="Vault · hedge"
      meta={<Tag tone={state.tone}>{state.tag}</Tag>}
      className={className}
      bodyClassName="grid md:grid-cols-[12rem_1fr_15rem] md:divide-x divide-line"
    >
      <div className="flex flex-col justify-center gap-3 p-4">
        <Label>Hedge ratio</Label>
        <p className={`font-mono text-[52px] leading-none font-semibold tracking-tight ${TONE_TEXT[state.tone]}`}>
          {pct}
          <span className="text-[28px]">%</span>
        </p>
        <p className="font-mono text-[11px] text-muted">{state.text}</p>
      </div>
      <div className="flex flex-col justify-center gap-2.5 border-t border-line p-4 md:border-t-0">
        <Bar label="Stock held · NVDAx" value={held} max={max} tone="bg-evm" />
        <Bar label="Short confirmed" value={confirmed} max={max} tone="bg-up" />
        <Bar label="Short on HyperCore" value={live} max={max} tone="bg-core" />
        <div className="mt-1 flex items-center justify-between">
          <Label className="text-faint">Hedge ratio · history</Label>
          <span className="font-mono text-[10px] text-faint">100% ref</span>
        </div>
        <div className="h-16">
          <ResponsiveContainer>
            <LineChart data={history} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
              <YAxis hide domain={[0, 1.4]} />
              <ReferenceLine y={1} stroke="#283037" strokeDasharray="3 3" />
              <Line type="stepAfter" dataKey="hedgeRatio" dot={false} stroke="#2ebd85" strokeWidth={1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="flex flex-col gap-4 border-t border-line p-4 md:border-t-0">
        <div className="flex flex-col gap-1">
          <Label>LP share price</Label>
          <p className="font-mono text-[28px] leading-none font-semibold">{vault.sharePrice.toFixed(4)}</p>
          <p className="text-[11px] text-faint">bought at a discount, marked at HyperCore&apos;s price</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="TVL" value={usd(vault.totalAssets, 2)} />
          <Stat label="Core margin" value={usd(vault.marginFloat, 2)} />
        </div>
      </div>
    </Panel>
  );
}
