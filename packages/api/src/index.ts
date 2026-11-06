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
import { loadDeployment } from "@afterbell/shared/node";
import { Collector } from "./collector.js";

const EXPLORER = {
  local: "",
  testnet: "https://app.hyperliquid-testnet.xyz/explorer/address/",
  mainnet: "https://app.hyperliquid.xyz/explorer/address/",
} as const;

const dep = loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH);
const remote = env.NETWORK === "local" ? null : env.NETWORK; // HyperEVM + Hyperliquid's info API
const client = createPublicClient({
  chain: remote ? chains[remote] : foundry,
  transport: http(env.RPC_URL ?? (remote ? rpcUrlFor(remote) : "http://127.0.0.1:8545")),
}) as PublicClient;

const chainId = await client.getChainId();
if (chainId !== dep.chainId) {
  throw new Error(`RPC is chain ${chainId}, but the deployment file is for chain ${dep.chainId}`);
}

const collector = new Collector(client, dep, {
  hlInfoUrl: remote ? (env.HL_INFO_API_URL ?? HL_INFO_API[remote]) : null,
  explorerUrl: EXPLORER[env.NETWORK] && `${EXPLORER[env.NETWORK]}${dep.vault}`,
  fromBlock: env.FROM_BLOCK ?? (remote ? null : 0n),
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

app.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    if (collector.latest !== null) {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(collector.latest) });
    }
    const unsubscribe = collector.subscribe(
      (s) => void stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) }),
    );
    stream.onAbort(() => void unsubscribe());
    while (!stream.aborted) await stream.sleep(30_000);
  }),
);

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
