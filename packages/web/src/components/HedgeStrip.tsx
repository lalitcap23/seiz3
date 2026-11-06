"use client";

import type { VaultSnapshot } from "@afterbell/shared";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { useHistory } from "@/lib/api";
import { coreSize, nvdax } from "@/lib/format";

const STATE_TEXT: Record<VaultSnapshot["hedgeState"], string> = {
  Idle: "hedged",
  Pending: "hedge in flight: waiting for syncHedge",
  Retrying: "retrying the hedge",
  Paused: "paused",
};

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  return (
    <div className="grid grid-cols-[9rem_1fr_5rem] items-center gap-2 text-xs tabular-nums">
      <span className="opacity-60">{label}</span>
      <div className="h-2 rounded-full bg-foreground/10">
        <div className={`h-2 rounded-full ${tone}`} style={{ width: `${max === 0 ? 0 : (100 * value) / max}%` }} />
      </div>
      <span className="text-right">{value.toFixed(3)}</span>
    </div>
  );
}

/** Hero number: hedge ratio. Should dip to 0% after the click, then snap to 100% when syncHedge lands. */
export function HedgeStrip({ vault, coreShort }: { vault: VaultSnapshot; coreShort: number | null }) {
  const { data: history = [] } = useHistory();
  const pct = Math.round(vault.hedgeRatio * 100);
  const tone = vault.paused || vault.hedgeState === "Paused" ? "text-red-500" : vault.hedgeState === "Idle" ? "text-emerald-500" : "text-amber-500";
  const held = nvdax(vault.inventory);
  const confirmed = Math.abs(coreSize(vault.confirmedShort, vault.szDecimals));
  const live = Math.abs(coreShort ?? 0);
  const max = Math.max(held, confirmed, live);

  return (
    <section className="grid gap-6 rounded-xl border border-foreground/10 p-4 md:grid-cols-[auto_1fr_auto]">
      <div>
        <p className="text-xs uppercase opacity-60">Hedge ratio</p>
        <p className={`text-6xl font-bold tabular-nums ${tone}`}>{pct}%</p>
        <p className="text-xs opacity-60">{vault.paused ? "paused" : STATE_TEXT[vault.hedgeState]}</p>
      </div>
      <div className="flex flex-col justify-center gap-2">
        <Bar label="Stock held (NVDAx)" value={held} max={max} tone="bg-sky-500" />
        <Bar label="Short confirmed" value={confirmed} max={max} tone="bg-emerald-500" />
        <Bar label="Short on HyperCore" value={live} max={max} tone="bg-violet-500" />
        <div className="h-16">
          <ResponsiveContainer>
            <LineChart data={history}>
              <YAxis hide domain={[0, 1.4]} />
              <Line type="stepAfter" dataKey="hedgeRatio" dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="text-right">
        <p className="text-xs uppercase opacity-60">LP share price</p>
        <p className="text-3xl font-semibold tabular-nums">{vault.sharePrice.toFixed(4)}</p>
        <p className="text-xs opacity-60">bought at a discount, marked at HyperCore&apos;s price</p>
      </div>
    </section>
  );
}
