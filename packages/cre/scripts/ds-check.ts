// Check Data Streams credentials outside CRE: which feeds they can read, and NVDA's latest marketStatus.
//   DATA_STREAMS_API_KEY=… DATA_STREAMS_API_SECRET=… npx tsx scripts/ds-check.ts [feedId…]
import { authHeaders, decodeMarketStatus } from "../src/datastreams";

const creds = { apiKey: process.env.DATA_STREAMS_API_KEY ?? "", apiSecret: process.env.DATA_STREAMS_API_SECRET ?? "" };
if (!creds.apiKey || !creds.apiSecret) throw new Error("set DATA_STREAMS_API_KEY and DATA_STREAMS_API_SECRET");
const hosts = ["https://api.dataengine.chain.link", "https://api.testnet-dataengine.chain.link"];
const feeds = process.argv.slice(2);

async function get(host: string, path: string) {
  const res = await fetch(host + path, {
    headers: { ...authHeaders("GET", path, "", creds, Date.now()), "User-Agent": "afterbell-cre/1.0" },
  });
  return { status: res.status, body: await res.text() };
}

for (const host of hosts) {
  const list = await get(host, "/api/v1/feeds");
  let ids: string[] = [];
  try {
    ids = (JSON.parse(list.body).feeds ?? []).map((f: { feedID: string }) => f.feedID);
  } catch {}
  console.log(`${host}: /feeds HTTP ${list.status}, ${ids.length} feed(s)${ids.length ? ": " + ids.join(", ") : " " + list.body.slice(0, 120)}`);
  for (const id of feeds.length ? feeds : ids) {
    const r = await get(host, `/api/v1/reports/latest?feedID=${id}`);
    if (r.status !== 200) {
      console.log(`  ${id}: HTTP ${r.status} ${r.body.slice(0, 120)}`);
      continue;
    }
    try {
      const d = decodeMarketStatus(JSON.parse(r.body).report.fullReport);
      console.log(`  ${id}: marketStatus ${d.status}, observed ${new Date(d.observedAt * 1000).toISOString()}`);
    } catch (e) {
      console.log(`  ${id}: report OK, ${(e as Error).message}`);
    }
  }
}
