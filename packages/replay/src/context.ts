import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { z } from "zod";
import { chains, rpcUrlFor, type MarketName } from "@afterbell/shared";
import { DEPLOYMENTS_DIR, loadDeployment, type DeploymentFile } from "@afterbell/shared/node";

const ANVIL_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const env = z
  .object({
    NETWORK: z.enum(["local", "testnet"]).default("local"),
    RPC_URL: z.string().url().optional(),
    DEPLOYMENTS_PATH: z.string().optional(),
    // owns the oracles, MockNVDAx, RiskParams, NaiveLiquidator and PoolSeeder: Deploy.s.sol's broadcaster
    REPLAY_PK: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    DROP_USD: z.coerce.number().positive().default(205), // the scene's weekend gap on the local stack
    MONDAY_USDC: z.coerce.number().positive().optional(), // deep liquidity monday adds (local default 1M)
    SHOW_NVDAX: z.coerce.number().positive().default(0.5), // testnet setup: collateral per demo borrower
    BUYERS: z.coerce.number().int().positive().default(3), // buyers step: hook fills to play
    KILL_SWITCH_FILE: z.string().default(`${DEPLOYMENTS_DIR}KILL`),
    HOLD_FILE: z.string().default(`${DEPLOYMENTS_DIR}BOTS_HOLD`), // packages/bots stands still while it exists
  })
  .parse(process.env);

const remote = env.NETWORK === "local" ? null : env.NETWORK;
export const local = remote === null;
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const pk = (env.REPLAY_PK ?? env.DEPLOYER_PRIVATE_KEY ?? (local ? ANVIL_DEPLOYER : undefined)) as Hex | undefined;
if (pk === undefined) throw new Error("set REPLAY_PK (the deployer's key) for testnet");
const chain = remote ? chains[remote] : foundry;
const rpcUrl =
  env.RPC_URL ?? (remote ? (rpcUrlFor(remote) ?? chain.rpcUrls.default.http[0]) : "http://127.0.0.1:8545");
const transport = http(rpcUrl);

export const owner = privateKeyToAccount(pk);
// viem's default 4 s receipt polling would add ~4 s per transaction to every click; HyperEVM and anvil make 1 s blocks
export const client = createPublicClient({ chain, transport, pollingInterval: 250 }) as PublicClient;
const wallet = createWalletClient({ account: owner, chain, transport });

let deployment: DeploymentFile | undefined;
const deploymentPath = () => env.DEPLOYMENTS_PATH ?? `${DEPLOYMENTS_DIR}${env.NETWORK}.json`;
/** Loaded on first use: setup writes the file the other steps read. */
export function dep(): DeploymentFile {
  deployment ??= loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH);
  return deployment;
}

/** Merge `fields` into the deployment file, keeping everything the scripts wrote. */
export function writeDeployment(fields: Record<string, unknown>): void {
  const raw = JSON.parse(readFileSync(deploymentPath(), "utf8")) as Record<string, unknown>;
  writeFileSync(deploymentPath(), `${JSON.stringify({ ...raw, ...fields }, null, 2)}\n`);
  deployment = undefined;
}

/** One transaction from the owner, waited for; throws on revert. */
export async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}

export async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return (await client.readContract({ address, abi, functionName, args } as never)) as T;
}

/** HyperCore's NVDA oracle in USDC 6 dec, through the read precompile (MockHyperCore's stub on the local stack). */
export async function coreOracleUsd6(): Promise<bigint> {
  const d = dep();
  const perpIndex = d.hypercore.perpAsset >= 100_000 ? d.hypercore.perpAsset - 100_000 : d.hypercore.perpAsset;
  const { data } = await client.call({
    to: "0x0000000000000000000000000000000000000807",
    data: encodeAbiParameters([{ type: "uint32" }], [perpIndex]),
  });
  const [raw] = decodeAbiParameters([{ type: "uint64" }], data ?? "0x");
  return raw * 10n ** BigInt(d.hypercore.szDecimals);
}

export function borrowerOf(market: MarketName): Address {
  const b = dep().borrowers.find((x) => x.label === market);
  if (b === undefined) throw new Error(`no ${market} borrower in the deployment file: run setup first`);
  return b.address;
}

/** The keeper's kill switch: held from setup until the marketC click, so market C waits for its own beat. */
export const keeper = {
  hold: () => writeFileSync(env.KILL_SWITCH_FILE, "replay\n"),
  release: () => rmSync(env.KILL_SWITCH_FILE, { force: true }),
  held: () => existsSync(env.KILL_SWITCH_FILE),
};

/** The testnet bots' hold: the oracle follower would undo the scene's crash, and the rebalancer the dump. */
export const bots = {
  hold: () => writeFileSync(env.HOLD_FILE, "replay\n"),
  release: () => rmSync(env.HOLD_FILE, { force: true }),
};

/** Runs a repo script (forge, local-stack.sh) with its output on ours. */
export function run(command: string, args: string[], extraEnv: Record<string, string> = {}, cwd = ROOT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0] ?? ""} exited ${code}`))));
  });
}

/** A forge script broadcast by the owner, as scripts/local-stack.sh runs them. */
export function forgeScript(name: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const args = ["script", `script/${name}`, "--rpc-url", rpcUrl, "--private-key", pk as string, "--broadcast", "--slow", "-q"];
  return run("forge", args, { NETWORK: env.NETWORK, ...extraEnv }, `${ROOT}contracts`);
}

export function localChain(): { core: Address } {
  return JSON.parse(readFileSync(`${DEPLOYMENTS_DIR}local-chain.json`, "utf8")) as { core: Address };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const usd = (usd6: bigint) => `$${(Number(usd6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const nvda = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(3)} NVDAx`;
