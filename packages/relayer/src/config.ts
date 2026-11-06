import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Address, Hex } from "viem";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as Address);

export const envSchema = z.object({
  NETWORK: z.string().default("base-sepolia"),
  DEPLOYMENTS_PATH: z.string().optional(), // default deployments/<NETWORK>.json
  RPC_URL: z.string().url(),
  /** Posts snapshots to the gateway: must be its `relayer`. */
  RELAYER_PK: key,
  BACKEND: z.enum(["hyperliquid", "mock"]).default("hyperliquid"),
  /** hyperliquid: the hedge account's key, or an API wallet it approved (then set HL_ACCOUNT). */
  HL_PRIVATE_KEY: key.optional(),
  /** The hedge account; default the gateway's `hedgeAccount`. */
  HL_ACCOUNT: address.optional(),
  HL_TESTNET: z.enum(["0", "1", "true", "false"]).default("1"),
  HL_DEX: z.string().default("xyz"),
  HL_COIN: z.string().default("xyz:NVDA"),
  /** mock: MockHyperCore on the local anvil; default the `core` in deployments/<NETWORK>-infra.json. */
  MOCK_CORE: address.optional(),
  TICK_MS: z.coerce.number().int().min(200).default(1000),
  /** A snapshot at least this often, orders or not: keeps the gateway inside maxStateAge and its oracle current. */
  HEARTBEAT_MS: z.coerce.number().int().min(1000).default(10_000),
  /** After placing an order, before reading the account back. */
  SETTLE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
});

export type Env = z.infer<typeof envSchema>;

export const deploymentSchema = z.object({
  chainId: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  vault: address,
  hyperCoreGateway: address,
  hedgeAccount: address.optional(),
  hypercore: z.object({ perpAsset: z.number(), perpDexIndex: z.number(), szDecimals: z.number() }),
});

export type RemoteDeployment = z.infer<typeof deploymentSchema>;

export const DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../deployments/", import.meta.url));

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  // compose and shells pass unset keys as "": treat them as unset
  return envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
}

export function loadDeployment(e: Env): { dep: RemoteDeployment; path: string } {
  const path = e.DEPLOYMENTS_PATH ?? `${DEPLOYMENTS_DIR}${e.NETWORK}.json`;
  const parsed = deploymentSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path}: not a Base Sepolia (remote) deployment — run DeployRemote.s.sol (${parsed.error.message})`);
  }
  return { dep: parsed.data, path };
}

/** MockHyperCore's address from deployments/<NETWORK>-infra.json (RemoteInfra.s.sol). */
export function infraCore(e: Env, deploymentPath: string): Address {
  if (e.MOCK_CORE) return e.MOCK_CORE;
  const infra = JSON.parse(readFileSync(deploymentPath.replace(/\.json$/, "-infra.json"), "utf8")) as { core?: string };
  if (!infra.core || /^0x0{40}$/.test(infra.core)) throw new Error("no MockHyperCore in the infra file: set MOCK_CORE");
  return infra.core as Address;
}

export const asHex = (k: string) => k as Hex;
