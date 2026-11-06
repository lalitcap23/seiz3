import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { createPublicClient, http, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { chains, HL_INFO_API, rpcUrlFor } from "@afterbell/shared";
import { env } from "./env.js";
import { DEPLOYMENTS_DIR, loadDeployment } from "@afterbell/shared/node";
import { Collector } from "./collector.js";
import { FaucetRelay } from "./faucet.js";
import { Watchlist } from "./watch.js";
import { readTx } from "./tx.js";
import { getConnInfo } from "@hono/node-server/conninfo";

const EXPLORER = {
  local: "",
  testnet: "https://app.hyperliquid-testnet.xyz/explorer/address/",
  mainnet: "https://app.hyperliquid.xyz/explorer/address/",
} as const;

const dep = loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH);
const remote = env.NETWORK === "local" ? null : env.NETWORK; // HyperEVM + Hyperliquid's info API
const chain = remote ? chains[remote] : foundry;
const rpcUrl = env.RPC_URL ?? (remote ? rpcUrlFor(remote) : "http://127.0.0.1:8545");
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
  explorerUrl: EXPLORER[env.NETWORK] && `${EXPLORER[env.NETWORK]}${dep.vault}`,
  fromBlock: env.FROM_BLOCK ?? (remote ? null : 0n),
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
    // anvil's reverts would make a cache lie; HyperEVM's blocks are final
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

/** The web's transaction page: decoded call, events and the vault's HyperCore orders (no public testnet explorer). */
app.get("/tx/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: "not a transaction hash" }, 400);
  const view = await readTx(client, collector.deployment, hash as `0x${string}`, {
    infoUrl: remote ? (env.HL_INFO_API_URL ?? HL_INFO_API[remote]) : null,
    explorer: EXPLORER[env.NETWORK] ? `${EXPLORER[env.NETWORK]}${dep.vault}` : null,
    txExplorer: EXPLORER[env.NETWORK] ? EXPLORER[env.NETWORK].replace("/address/", "/tx/") : null,
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

/** Testers' first step: NVDAx to borrow against, a little USDC, and HYPE for gas, sent by the operator key. */
app.post("/faucet", async (c) => {
  if (faucet === null) return c.json({ error: "faucet not configured on this API" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as { address?: string };
  const forwarded = env.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  const ip = forwarded ?? getConnInfo(c).remote.address ?? "unknown";
  watchlist.add(body.address ?? "");
  const result = await faucet.drip(body.address ?? "", ip);
  return result.ok ? c.json(result) : c.json(result, result.status);
});

const REPLAY_STEPS = ["setup", "reset", "scene", "marketA", "marketB", "marketC", "monday"];
let replaying: string | null = null;

/** `pnpm replay <step>` in the repo, with this process's env; resolves with its exit status and output tail. */
function runReplay(step: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["--silent", "--filter", "@afterbell/replay", "start", step], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: process.env,
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => resolve({ ok: false, output: String(error) }));
    child.on("exit", (code) => resolve({ ok: code === 0, output }));
  });
}

/** The presenter's clicker: one demo step at a time, answered when it has finished. */
app.post("/replay/:step", async (c) => {
  // the steps move real oracles with the deployer's key: a public API never runs them on the example token
  if (remote && env.REPLAY_TOKEN === "change-me") return c.json({ error: "set REPLAY_TOKEN to enable replay" }, 503);
  if (c.req.header("authorization") !== `Bearer ${env.REPLAY_TOKEN}`)
    return c.json({ error: "unauthorized" }, 401);
  const step = c.req.param("step");
  if (!REPLAY_STEPS.includes(step)) return c.json({ error: `unknown step ${step}`, steps: REPLAY_STEPS }, 404);
  if (replaying !== null) return c.json({ error: `${replaying} is still running` }, 409);
  replaying = step;
  try {
    const { ok, output } = await runReplay(step);
    if (ok && step === "setup") collector.reload(loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH)); // new addresses
    return c.json({ ok, step, output }, ok ? 200 : 500);
  } finally {
    replaying = null;
  }
});

serve({ fetch: app.fetch, port: env.API_PORT }, (info) =>
  console.log(`[api] ${env.NETWORK} vault ${dep.vault}, listening on http://localhost:${info.port}`),
);
