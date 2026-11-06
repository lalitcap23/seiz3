// External data step: Hyperliquid's public info API — the perp oracle the vault hedges against.
// This is the "connect a blockchain to an external API" leg of the CRE qualification: the workflow
// reads on-chain state (Morpho/DemoOracle) and the off-chain Hyperliquid market in the same run.

import { cre, ok, text, type NodeRuntime, type Runtime } from "@chainlink/cre-sdk";

export interface HyperliquidConfig {
  readonly apiUrl: string;
  readonly coin: string; // e.g. "xyz:NVDA" — the HIP-3 perp the vault shorts
}

interface CandleResponse {
  readonly t: number;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  readonly v: string;
}

const USDC = 1_000_000n;

/** Last 5m-candle close of `coin`, scaled to USDC (6 decimals) per unit. */
export function readPerpPriceUsd6(runtime: Runtime<unknown>, config: HyperliquidConfig): bigint {
  const http = new cre.capabilities.HTTPClient();
  // the direct-request overload is typed against NodeRuntime; the handler runs on a node runtime
  const nodeRuntime = runtime as unknown as NodeRuntime<unknown>;
  const response = http
    .sendRequest(nodeRuntime, {
      url: config.apiUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin: config.coin,
          interval: "5m",
          startTime: Date.now() - 15 * 60_000,
          endTime: Date.now(),
        },
      }),
    })
    .result();

  if (!ok(response)) throw new Error(`hyperliquid HTTP ${response.statusCode}`);
  const candles = JSON.parse(text(response)) as CandleResponse[];
  const last = candles[candles.length - 1];
  if (!last) throw new Error("hyperliquid: no candles returned");

  const usd6 = BigInt(Math.round(Number(last.c) * Number(USDC)));
  if (usd6 <= 0n) throw new Error("hyperliquid price non-positive");
  return usd6;
}
