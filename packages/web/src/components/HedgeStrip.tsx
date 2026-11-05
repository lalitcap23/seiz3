"use client";

import type { VaultSnapshot } from "@afterbell/shared";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { useHistory } from "@/lib/api";

/** Hero number: hedge ratio. Should dip to 0% after the click, then snap to 100% when syncHedge lands. */
export function HedgeStrip({ vault }: { vault: VaultSnapshot }) {
  const { data: history = [] } = useHistory();
  const pct = Math.round(vault.hedgeRatio * 100);
  const ok = vault.hedgeState === "Idle" && !vault.paused;

  return (
    <section className="grid gap-4 rounded-xl border border-foreground/10 p-4 md:grid-cols-[auto_1fr_auto]">
      <div>
        <p className="text-xs uppercase opacity-60">Hedge ratio</p>
        <p
          className={`text-5xl font-bold tabular-nums ${ok ? "text-emerald-500" : "text-amber-500"}`}
        >
          {pct}%
        </p>
        <p className="text-xs opacity-60">
          {vault.hedgeState}
          {vault.paused ? " · paused" : ""}
        </p>
      </div>
      <div className="h-24">
        <ResponsiveContainer>
          <LineChart data={history}>
            <YAxis hide domain={[0, 1.1]} />
            <Line
              type="stepAfter"
              dataKey="hedgeRatio"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-right">
        <p className="text-xs uppercase opacity-60">LP share price</p>
        <p className="text-2xl font-semibold tabular-nums">{vault.sharePrice.toFixed(4)}</p>
      </div>
    </section>
  );
}
