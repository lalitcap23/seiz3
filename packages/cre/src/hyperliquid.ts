// Hyperliquid's info API, read by every node in node mode: xyz:NVDA's order book (`l2Book`) and its oracle price
// (`metaAndAssetCtxs` on the xyz dex). The HyperCore precompiles give the vault the oracle, but not the book.

import { cre, ok, text, type NodeRuntime } from "@chainlink/cre-sdk";

import { hedgeCapacityUsd6, parseDecimal, type Level } from "./book";

export interface HyperliquidConfig {
  readonly apiUrl: string;
  readonly dex: string; // HIP-3 dex the perp lives on, e.g. "xyz"
  readonly coin: string; // e.g. "xyz:NVDA", the perp the vault shorts
}

/** One node's view of the book; the DON takes the median of each field. */
export interface BookRead {
  readonly capacityUsd6: bigint;
  readonly observedAt: number; // unix seconds of the book snapshot
}

interface L2Book {
  readonly coin: string;
  readonly time: number; // ms
  readonly levels: readonly [readonly Level[], readonly Level[]]; // [bids, asks], best first
}

type MetaAndAssetCtxs = readonly [
  { readonly universe: readonly { readonly name: string }[] },
  readonly { readonly oraclePx: string }[],
];

function post<T>(nodeRuntime: NodeRuntime<unknown>, url: string, body: object): T {
  const response = new cre.capabilities.HTTPClient()
    .sendRequest(nodeRuntime, {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    })
    .result();
  if (!ok(response)) throw new Error(`hyperliquid ${JSON.stringify(body)}: HTTP ${response.statusCode}`);
  return JSON.parse(text(response)) as T;
}

export function oracleUsd6(ctxs: MetaAndAssetCtxs, coin: string): bigint {
  const [meta, assets] = ctxs;
  const i = meta.universe.findIndex((a) => a.name === coin);
  const px = i < 0 ? undefined : assets[i]?.oraclePx;
  if (px === undefined) throw new Error(`hyperliquid: no oracle price for ${coin}`);
  return parseDecimal(px, 6);
}

/** What one hedge can sell into on `coin`'s book right now, and when the book was read. */
export function readHedgeCapacity(
  nodeRuntime: NodeRuntime<unknown>,
  cfg: HyperliquidConfig,
  hedgeCapBps: bigint,
  bookShareBps: bigint,
): BookRead {
  const book = post<L2Book>(nodeRuntime, cfg.apiUrl, { type: "l2Book", coin: cfg.coin });
  if (book.coin !== cfg.coin) throw new Error(`hyperliquid: asked for ${cfg.coin}, got ${book.coin}`);
  const oracle = oracleUsd6(post<MetaAndAssetCtxs>(nodeRuntime, cfg.apiUrl, { type: "metaAndAssetCtxs", dex: cfg.dex }), cfg.coin);
  if (oracle === 0n) throw new Error(`hyperliquid: zero oracle price for ${cfg.coin}`);
  return {
    capacityUsd6: hedgeCapacityUsd6(book.levels[0], oracle, hedgeCapBps, bookShareBps),
    observedAt: Math.floor(book.time / 1000),
  };
}
