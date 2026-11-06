// Chainlink Data Streams, read by every node in node mode: the latest report of the NVDA US-equity stream, for its
// `marketStatus` field. The REST API signs each request with HMAC-SHA256 over
// "<method> <path?query> <sha256(body)> <apiKey> <timestampMs>" (docs.chain.link/data-streams, API authentication).
// node:crypto doesn't exist in the CRE runtime, so the hashing is @noble/hashes (pure JS).

import { cre, ok, text, type NodeRuntime } from "@chainlink/cre-sdk";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, decodeAbiParameters, type Hex } from "viem";

export interface DataStreamsConfig {
  readonly apiUrl: string; // https://api.dataengine.chain.link (mainnet streams; independent of the chain we write to)
  readonly feedId: string; // 0x0008… (RWA Standard, v8) or 0x000b… (RWA Advanced, v11)
}

export interface Credentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/** One node's view of the stream; the DON requires the same status from every node. */
export interface MarketStatusRead {
  readonly status: number;
  readonly observedAt: number; // the report's observationsTimestamp, unix seconds
  // v11 (RWA Advanced) only, 0 for v8: the equity market's top of book in the stream (USD 6 dec, shares × 1e6)
  readonly bidUsd6: bigint;
  readonly bidSize: bigint;
  readonly askUsd6: bigint;
  readonly askSize: bigint;
}

/** v11's top of book: bid, bidVolume, ask, askVolume (18 decimals each) → USD 6 dec and shares × 1e6. */
export interface TopOfBook {
  readonly bidUsd6: bigint;
  readonly bidSize: bigint;
  readonly askUsd6: bigint;
  readonly askSize: bigint;
}

const NO_BOOK: TopOfBook = { bidUsd6: 0n, bidSize: 0n, askUsd6: 0n, askSize: 0n };
const E12 = 10n ** 12n;
const nonNegative = (x: bigint) => (x > 0n ? x / E12 : 0n);

/** `marketStatus` that means the US stock market is in regular hours: v8 "Open", v11 "Regular hours". */
export const MARKET_OPEN = 2;

const REPORT_PATH = "/api/v1/reports/latest";
const USER_AGENT = "afterbell-cre/1.0";

// ASCII only (method, path, hex, the key's UUID, digits): no TextEncoder needed in the WASM runtime
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function authHeaders(
  method: string,
  pathWithQuery: string,
  body: string,
  creds: Credentials,
  timestampMs: number,
): Record<string, string> {
  const bodyHash = bytesToHex(sha256(ascii(body))).slice(2);
  const toSign = `${method} ${pathWithQuery} ${bodyHash} ${creds.apiKey} ${timestampMs}`;
  return {
    Authorization: creds.apiKey,
    "X-Authorization-Timestamp": String(timestampMs),
    "X-Authorization-Signature-SHA256": bytesToHex(hmac(sha256, ascii(creds.apiSecret), ascii(toSign))).slice(2),
  };
}

const V8_BODY = [
  { name: "feedId", type: "bytes32" },
  { name: "validFromTimestamp", type: "uint32" },
  { name: "observationsTimestamp", type: "uint32" },
  { name: "nativeFee", type: "uint192" },
  { name: "linkFee", type: "uint192" },
  { name: "expiresAt", type: "uint32" },
  { name: "lastUpdateTimestamp", type: "uint64" },
  { name: "midPrice", type: "int192" },
  { name: "marketStatus", type: "uint32" },
] as const;

const V11_BODY = [
  { name: "feedId", type: "bytes32" },
  { name: "validFromTimestamp", type: "uint32" },
  { name: "observationsTimestamp", type: "uint32" },
  { name: "nativeFee", type: "uint192" },
  { name: "linkFee", type: "uint192" },
  { name: "expiresAt", type: "uint32" },
  { name: "mid", type: "int192" },
  { name: "lastSeenTimestampNs", type: "uint64" },
  { name: "bid", type: "int192" },
  { name: "bidVolume", type: "int192" },
  { name: "ask", type: "int192" },
  { name: "askVolume", type: "int192" },
  { name: "lastTradedPrice", type: "int192" },
  { name: "marketStatus", type: "uint32" },
] as const;

/** `fullReport` = abi.encode(bytes32[3] context, bytes reportBlob, bytes32[] rs, bytes32[] ss, bytes32 rawVs). */
export function decodeMarketStatus(
  fullReport: Hex,
): { feedId: Hex; observedAt: number; status: number; book: TopOfBook } {
  const [, blob] = decodeAbiParameters(
    [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32" }],
    fullReport,
  );
  const version = Number.parseInt(blob.slice(2, 6), 16); // a feed id's first two bytes are its schema version
  if (version === 8) {
    const [feedId, , observedAt, , , , , , status] = decodeAbiParameters(V8_BODY, blob);
    return { feedId, observedAt, status, book: NO_BOOK };
  }
  if (version === 11) {
    const [feedId, , observedAt, , , , , , bid, bidVolume, ask, askVolume, , status] = decodeAbiParameters(V11_BODY, blob);
    const book = {
      bidUsd6: nonNegative(bid),
      bidSize: nonNegative(bidVolume),
      askUsd6: nonNegative(ask),
      askSize: nonNegative(askVolume),
    };
    return { feedId, observedAt, status, book };
  }
  throw new Error(`data streams: schema v${version} has no marketStatus`);
}

export function readMarketStatus(
  nodeRuntime: NodeRuntime<unknown>,
  cfg: DataStreamsConfig,
  creds: Credentials,
): MarketStatusRead {
  const path = `${REPORT_PATH}?feedID=${cfg.feedId}`;
  const response = new cre.capabilities.HTTPClient()
    .sendRequest(nodeRuntime, {
      url: `${cfg.apiUrl}${path}`,
      method: "GET",
      // Cloudflare in front of the API turns away requests without a recognised User-Agent (error 1010)
      headers: { ...authHeaders("GET", path, "", creds, nodeRuntime.now().getTime()), "User-Agent": USER_AGENT },
    })
    .result();
  if (!ok(response)) throw new Error(`data streams: HTTP ${response.statusCode} ${text(response).slice(0, 200)}`);

  const { report } = JSON.parse(text(response)) as { report: { fullReport: Hex } };
  const decoded = decodeMarketStatus(report.fullReport);
  if (decoded.feedId.toLowerCase() !== cfg.feedId.toLowerCase()) {
    throw new Error(`data streams: asked for ${cfg.feedId}, got ${decoded.feedId}`);
  }
  return { status: decoded.status, observedAt: decoded.observedAt, ...decoded.book };
}
