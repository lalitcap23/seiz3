"use client";

import { useSnapshot } from "@/lib/api";
import { ActivityFeed } from "./ActivityFeed";
import { HedgeStrip } from "./HedgeStrip";
import { HyperliquidPanel } from "./HyperliquidPanel";
import { MarketColumns } from "./MarketColumns";
import { Operations } from "./Operations";
import { PresenterBar } from "./PresenterBar";
import { StatusBar } from "./StatusBar";

export function Dashboard() {
  const { data, isError } = useSnapshot();
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4 pb-20">
      {isError && <p className="text-sm text-amber-500">API unreachable, showing last snapshot</p>}
      <StatusBar data={data} />
      <MarketColumns markets={data.markets} />
      <HedgeStrip vault={data.vault} coreShort={data.hyperliquid?.size ?? null} />
      <Operations operations={data.operations ?? []} szDecimals={data.vault.szDecimals} />
      <div className="grid gap-4 md:grid-cols-[2fr_3fr]">
        <HyperliquidPanel data={data.hyperliquid} />
        <ActivityFeed events={data.activity} szDecimals={data.vault.szDecimals} />
      </div>
      <PresenterBar />
    </div>
  );
}
