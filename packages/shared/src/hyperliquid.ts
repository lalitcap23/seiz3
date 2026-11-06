/** Read-only Hyperliquid info API client. The keeper never signs Hyperliquid orders. */

export const PERP_DEX = "xyz";
export const PERP_COIN = "xyz:NVDA";

async function info<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000), // a hung request would stall whichever loop awaits it
  });
  if (!res.ok) throw new Error(`HL info ${body.type} → ${res.status}`);
  return (await res.json()) as T;
}

export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      unrealizedPnl: string;
      marginUsed: string;
    };
  }[];
}

export const hl = (url: string) => ({
  clearinghouseState: (user: string, dex = PERP_DEX) =>
    info<ClearinghouseState>(url, { type: "clearinghouseState", user, dex }),
  metaAndAssetCtxs: (dex = PERP_DEX) => info<unknown[]>(url, { type: "metaAndAssetCtxs", dex }),
  meta: (dex = PERP_DEX) =>
    info<{ universe: { name: string; szDecimals: number }[] }>(url, { type: "meta", dex }),
  perpDexs: () => info<({ name: string } | null)[]>(url, { type: "perpDexs" }),
  orderStatus: (user: string, cloid: string) =>
    info<unknown>(url, { type: "orderStatus", user, oid: cloid }),
});
