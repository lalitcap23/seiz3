import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { createPublicClient, http, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { chains, HL_INFO_API, rpcUrlFor } from "@seiz3/shared";
import { env } from "./env.js";
import { DEPLOYMENTS_DIR, loadDeployment } from "@seiz3/shared/node";
import { Collector } from "./collector.js";
import { FaucetRelay } from "./faucet.js";
import { Watchlist } from "./watch.js";
import { readTx } from "./tx.js";
import { getConnInfo } from "@hono/node-server/conninfo";

/** Where the hedge account (the one holding the short) opens on HyperCore's explorer. */
const EXPLORER = {
  "local-base": "",
  "base-sepolia": "https://app.hyperliquid-testnet.xyz/explorer/address/",
} as const;
/** Where the vault's own transactions open. */
const TX_EXPLORER = {
  "local-base": "",
  "base-sepolia": "https://sepolia.basescan.org/tx/",
} as const;

const dep = loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH);
// Base Sepolia + Hyperliquid's info API; null on the local anvil (scripts/base-stack.sh local)
const remote = env.NETWORK === "local-base" ? null : env.NETWORK;
const chain = remote ? chains[remote] : foundry;
const rpcUrl = env.RPC_URL ?? (remote ? rpcUrlFor(remote) : "http://127.0.0.1:8546");
/** The HyperCore account that holds the short: the relayer's hedge account. */
const coreAccount = dep.hedgeAccount;
// viem's default (10 s, 3 retries) lets one stuck call hold the 1 s poll for 40 s; the next poll is the retry
const transport = (url: string | undefined) => http(url, { timeout: 8_000, retryCount: 1 });
const client = createPublicClient({ chain, transport: transport(rpcUrl) }) as PublicClient;

const chainId = await client.getChainId();
if (chainId !== dep.chainId) {
  throw new Error(`RPC is chain ${chainId}, but the deployment file is for chain ${dep.chainId}`);
}

// testers the keeper and the dashboard follow: /try connects and faucet drips
const watchlist = new Watchlist(env.WATCH_FILE ?? `${DEPLOYMENTS_DIR}watch.json`);

const collector = new Collector(client, dep, {
  hlInfoUrl: remote ? (env.HL_INFO_API_URL ?? HL_INFO_API[remote]) : null,
  explorerUrl: EXPLORER[env.NETWORK] && `${EXPLORER[env.NETWORK]}${coreAccount}`,
  // where the deployment's markets were created: nothing of ours exists before it
  fromBlock: env.FROM_BLOCK ?? (dep.startBlock !== undefined ? BigInt(dep.startBlock) : remote ? null : 0n),
  logs: {
    ...(env.LOGS_RPC_URL
      ? {
          // no retry: on a rate limit an instant one only doubles the count; the backfill backs off instead
          logsClient: createPublicClient({
            chain,
            transport: http(env.LOGS_RPC_URL, { timeout: 8_000, retryCount: 0 }),
          }) as PublicClient,
        }
      : {}),
    backfillPage: env.LOG_PAGE,
    backfillGapMs: env.LOG_SCAN_MS,
    // anvil's reverts would make a cache lie; Base Sepolia's blocks are final
    ...(remote ? { cacheFile: env.FEED_CACHE_FILE ?? `${DEPLOYMENTS_DIR}feed-cache.${env.NETWORK}.json` } : {}),
    chainRewinds: !remote,
  },
  extraBorrowers: () => watchlist.list(),
});
collector.start(env.POLL_MS);

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) =>
  c.json({
    ok: collector.latest !== null && collector.lastError === null,
    network: env.NETWORK,
    vault: dep.vault,
    blockNumber: collector.latest?.blockNumber ?? null,
    updatedAt: collector.latest?.updatedAt ?? null,
    lastError: collector.lastError,
    logError: collector.logError, // activity feed behind while set
    feed: collector.latest?.feed ?? null,
  }),
);

app.get("/snapshot", (c) =>
  collector.latest === null
    ? c.json({ error: "no snapshot yet", lastError: collector.lastError }, 503)
    : c.json(collector.latest),
);

app.get("/history", (c) => {
  const from = Number(c.req.query("from") ?? 0);
  return c.json(collector.history.filter((p) => p.t >= from));
});

/** The page's whole feed: every snapshot, and a heartbeat that says why none came (the API's own reads failing). */
const HEARTBEAT_MS = 5_000;

app.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    if (collector.latest !== null) {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(collector.latest) });
    }
    const unsubscribe = collector.subscribe(
      (s) => void stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) }),
    );
    stream.onAbort(() => void unsubscribe());
    while (!stream.aborted) {
      await stream.sleep(HEARTBEAT_MS);
      await stream.writeSSE({
        event: "health",
        data: JSON.stringify({ lastError: collector.lastError, updatedAt: collector.latest?.updatedAt ?? null }),
      });
    }
  }),
);

/** The web's transaction page: decoded call, events and the vault's HyperCore orders. */
app.get("/tx/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: "not a transaction hash" }, 400);
  const view = await readTx(client, collector.deployment, hash as `0x${string}`, {
    infoUrl: remote ? (env.HL_INFO_API_URL ?? HL_INFO_API[remote]) : null,
    explorer: EXPLORER[env.NETWORK] ? `${EXPLORER[env.NETWORK]}${coreAccount}` : null,
    txExplorer: TX_EXPLORER[env.NETWORK] || null,
  }).catch((error: unknown) => ({ error: error instanceof Error ? error.message.split("\n")[0] : String(error) }));
  if (view === null) return c.json({ error: "transaction not found (yet)" }, 404);
  return "error" in view ? c.json(view, 502) : c.json(view);
});


/** /try calls this on connect: from then on the keeper checks the address every tick, with no log scan involved. */
app.post("/watch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { address?: string };
  return watchlist.add(body.address ?? "") ? c.json({ ok: true, watched: watchlist.size }) : c.json({ error: "not an address" }, 400);
});

const faucet =
  env.FAUCET_OPERATOR_PRIVATE_KEY && dep.faucet
    ? new FaucetRelay(client, chain, rpcUrl, env.FAUCET_OPERATOR_PRIVATE_KEY as `0x${string}`, dep.faucet, env.FAUCET_IP_COOLDOWN_SEC)
    : null;

/** Testers' first step: NVDAx to borrow against, a little USDC, and ETH for gas, sent by the operator key. */
app.post("/faucet", async (c) => {
  if (faucet === null) return c.json({ error: "faucet not configured on this API" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as { address?: string };
  const forwarded = env.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  const ip = forwarded ?? getConnInfo(c).remote.address ?? "unknown";
  watchlist.add(body.address ?? "");
  const result = await faucet.drip(body.address ?? "", ip);
  return result.ok ? c.json(result) : c.json(result, result.status);
});

serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(`[api] ${env.NETWORK} vault ${dep.vault}, listening on http://localhost:${info.port}`),
);
