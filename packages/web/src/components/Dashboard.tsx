"use client";

import type { Snapshot } from "@afterbell/shared";
import { useLive, useSnapshot } from "@/lib/api";
import { ActivityFeed } from "./ActivityFeed";
import { HedgeStrip } from "./HedgeStrip";
import { HyperliquidPanel } from "./HyperliquidPanel";
import { MarketColumns } from "./MarketColumns";
import { Operations } from "./Operations";
import { PresenterBar } from "./PresenterBar";
import { StatusBar } from "./StatusBar";

/** Blocks the feed may trail the head before it's worth saying (a poll is 1–2 blocks). */
const FEED_LAG = 5;

/** Says why the page isn't live instead of quietly showing old numbers; nothing while everything is current. */
function FeedBanner({ data }: { data: Snapshot }) {
  const live = useLive();
  const at = live.receivedAt === null ? "" : ` Showing ${new Date(live.receivedAt).toLocaleTimeString([], { hour12: false })}.`;
  const feed = data.feed;
  const lines: string[] = [];
  if (live.down) lines.push(`Live updates lost: reconnecting to the API, and refreshing every few seconds meanwhile.${at}`);
  else if (live.apiError) lines.push(`The API can't read the chain right now (${live.apiError}).${at}`);
  if (feed && feed.behind > FEED_LAG) {
    lines.push(`Activity is ${feed.behind} blocks behind the chain${feed.error ? ` (${feed.error})` : ""}: catching up.`);
  }
  if (feed && feed.historyLeft > 0) {
    lines.push(`Loading earlier activity, ${feed.historyLeft} blocks to go${feed.error ? ` (logs RPC: ${feed.error})` : ""}.`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-sm text-amber-500">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

export function Dashboard() {
  const { data } = useSnapshot();
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4 pb-20">
      <FeedBanner data={data} />
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
