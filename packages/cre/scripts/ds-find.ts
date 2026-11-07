// Find a stream by price among the RWA streams (schemas v8 / v11) these Data Streams credentials can read.
//   DATA_STREAMS_API_KEY=… DATA_STREAMS_API_SECRET=… tsx scripts/ds-find.ts <usd price> [host]
import { decodeAbiParameters, type Hex } from "viem";
import { authHeaders, decodeMarketStatus } from "../src/datastreams";

const creds = { apiKey: process.env.DATA_STREAMS_API_KEY ?? "", apiSecret: process.env.DATA_STREAMS_API_SECRET ?? "" };
const target = Number(process.argv[2]);
const host = process.argv[3] ?? "https://api.testnet-dataengine.chain.link";
const get = async (path: string) => {
  const res = await fetch(host + path, { headers: { ...authHeaders("GET", path, "", creds, Date.now()), "User-Agent": "seiz3-cre/1.0" } });
  return res.ok ? JSON.parse(await res.text()) : null;
};
const ids: string[] = ((await get("/api/v1/feeds"))?.feeds ?? []).map((f: { feedID: string }) => f.feedID);
const rwa = ids.filter((id) => id.startsWith("0x0008") || id.startsWith("0x000b"));
console.log(`${ids.length} feeds, ${rwa.length} RWA (v8/v11)`);
for (const id of rwa) {
  const r = await get(`/api/v1/reports/latest?feedID=${id}`);
  if (!r) continue;
  const full = r.report.fullReport as Hex;
  const [, blob] = decodeAbiParameters([{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32" }], full);
  // v8: midPrice is word 7; v11: mid is word 6, bid 8, bidVolume 9, ask 10, askVolume 11
  const words = (blob.length - 2) / 64;
  const word = (i: number) => BigInt("0x" + blob.slice(2 + i * 64, 2 + (i + 1) * 64));
  const mid = Number(word(id.startsWith("0x0008") ? 7 : 6)) / 1e18;
  const { status, observedAt } = decodeMarketStatus(full);
  if (Math.abs(mid / target - 1) < 0.03) {
    const extra = id.startsWith("0x000b") ? ` bid ${Number(word(8)) / 1e18} x ${Number(word(9)) / 1e18}, ask ${Number(word(10)) / 1e18} x ${Number(word(11)) / 1e18}` : "";
    console.log(`${id} v${id.startsWith("0x0008") ? 8 : 11} mid ${mid} status ${status} observed ${new Date(observedAt * 1000).toISOString()} (${words} words)${extra}`);
  }
}
