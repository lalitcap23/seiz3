"use client";

import { useSnapshot } from "@/lib/api";
import { MarketColumns } from "./MarketColumns";
import { HyperliquidPanel } from "./HyperliquidPanel";
import { HedgeStrip } from "./HedgeStrip";

export function Dashboard() {
  const { data, isError } = useSnapshot();
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      {isError && <p className="text-sm text-amber-500">API unreachable, showing last snapshot</p>}
      <MarketColumns markets={data.markets} />
      <HyperliquidPanel data={data.hyperliquid} updatedAt={data.updatedAt} />
      <HedgeStrip vault={data.vault} />
    </div>
  );
}
