// The Seiz3 relayer: HyperCoreGateway (Base Sepolia) ↔ the hedge account on HyperCore.
//
//   gateway.orders(n) ─► place on HyperCore (IOC, vault's cloid) ─► read the account ─► gateway.relay(snapshot, ack n)
//   every HEARTBEAT_MS ─► gateway.relay(snapshot)         (keeps the vault's view of HyperCore inside maxStateAge)
//
// BACKEND=hyperliquid trades the real hedge account (HL_PRIVATE_KEY); BACKEND=mock trades MockHyperCore on a local anvil.
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperCoreGatewayAbi } from "@seiz3/shared/abis";

import { asHex, infraCore, loadDeployment, loadEnv } from "./config.js";
import { HyperliquidBackend } from "./hyperliquid.js";
import { MockBackend } from "./mock.js";
import { Relayer } from "./relayer.js";
import type { HyperCoreBackend } from "./types.js";

const bigintSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), relayer: event, ...fields }, bigintSafe));

const env = loadEnv();
const { dep, path } = loadDeployment(env);
const chain = defineChain({
  id: dep.chainId,
  name: env.NETWORK,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const transport = http(env.RPC_URL, { retryCount: 2, timeout: 20_000 });
const client = createPublicClient({ chain, transport, pollingInterval: 500 }) as PublicClient;
const signer = privateKeyToAccount(asHex(env.RELAYER_PK));
const wallet = createWalletClient({ account: signer, chain, transport });

const onChainId = await client.getChainId();
if (onChainId !== dep.chainId) throw new Error(`RPC is chain ${onChainId}, ${path} is chain ${dep.chainId}`);
const gatewayRelayer = (await client.readContract({
  address: dep.hyperCoreGateway,
  abi: hyperCoreGatewayAbi,
  functionName: "relayer",
})) as string;
if (gatewayRelayer.toLowerCase() !== signer.address.toLowerCase()) {
  throw new Error(`RELAYER_PK is ${signer.address}, but the gateway's relayer is ${gatewayRelayer}`);
}
const hedge =
  env.HL_ACCOUNT ??
  ((await client.readContract({ address: dep.hyperCoreGateway, abi: hyperCoreGatewayAbi, functionName: "hedgeAccount" })) as `0x${string}`);

let backend: HyperCoreBackend;
if (env.BACKEND === "mock") {
  backend = new MockBackend(client, chain, env.RPC_URL, signer, infraCore(env, path), hedge, dep.hypercore.szDecimals);
} else {
  if (!env.HL_PRIVATE_KEY) throw new Error("BACKEND=hyperliquid needs HL_PRIVATE_KEY (the hedge account's key or its API wallet)");
  backend = new HyperliquidBackend(asHex(env.HL_PRIVATE_KEY), hedge, {
    testnet: env.HL_TESTNET === "1" || env.HL_TESTNET === "true",
    dex: env.HL_DEX,
    coin: env.HL_COIN,
    szDecimals: dep.hypercore.szDecimals,
  });
}

const relayer = new Relayer(
  client,
  wallet,
  dep.hyperCoreGateway,
  backend,
  { heartbeatMs: env.HEARTBEAT_MS, settleDelayMs: env.SETTLE_DELAY_MS },
  log,
);
log("start", { backend: backend.name, gateway: dep.hyperCoreGateway, hedgeAccount: hedge, signer: signer.address, chainId: dep.chainId });

let failures = 0;
for (;;) {
  try {
    await relayer.tick();
    failures = 0;
  } catch (error) {
    failures += 1;
    log("error", { failures, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
  }
  await new Promise((r) => setTimeout(r, failures === 0 ? env.TICK_MS : Math.min(30_000, env.TICK_MS * 2 ** failures)));
}
