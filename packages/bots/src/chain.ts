import { createPublicClient, createWalletClient, decodeAbiParameters, encodeAbiParameters, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chains, extsloadAbi, poolSlots, rpcUrlFor, slot0SqrtPrice, type PoolKey } from "@afterbell/shared";
import { loadDeployment } from "@afterbell/shared/node";
import { env } from "./env.js";

export const dep = loadDeployment(env.NETWORK, env.DEPLOYMENTS_PATH);
const chain = chains[env.NETWORK];
const transport = http(env.RPC_URL ?? rpcUrlFor(env.NETWORK));
export const client = createPublicClient({ chain, transport, pollingInterval: 500 }) as PublicClient;

export const owner = env.DEPLOYER_PRIVATE_KEY ? privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex) : null;
const wallet = owner ? createWalletClient({ account: owner, chain, transport }) : null;

/** One transaction from the deployer, waited for; throws on revert. The EVM bots run one at a time. */
export async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  if (wallet === null) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

export async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return (await client.readContract({ address, abi, functionName, args } as never)) as T;
}

/** HyperCore's NVDA oracle in USDC 6 dec, through the oraclePx precompile (6 − szDecimals decimals). */
export async function coreOracleUsd6(): Promise<bigint> {
  const perpIndex = dep.hypercore.perpAsset >= 100_000 ? dep.hypercore.perpAsset - 100_000 : dep.hypercore.perpAsset;
  const { data } = await client.call({
    to: "0x0000000000000000000000000000000000000807",
    data: encodeAbiParameters([{ type: "uint32" }], [perpIndex]),
  });
  const [raw] = decodeAbiParameters([{ type: "uint64" }], data ?? "0x");
  return raw * 10n ** BigInt(dep.hypercore.szDecimals);
}

export async function poolState(key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> {
  const slots = poolSlots(key);
  const [slot0, liquidity] = await Promise.all([
    read<Hex>(dep.poolManager, extsloadAbi, "extsload", [slots.slot0]),
    read<Hex>(dep.poolManager, extsloadAbi, "extsload", [slots.liquidity]),
  ]);
  return { sqrtPriceX96: slot0SqrtPrice(slot0), liquidity: BigInt(liquidity) & ((1n << 128n) - 1n) };
}

/** |a − b| / b in bps. */
export const diffBps = (a: bigint, b: bigint) => (b === 0n ? Infinity : Number(((a > b ? a - b : b - a) * 10_000n) / b));
export const usd = (usd6: bigint) => `$${(Number(usd6) / 1e6).toFixed(2)}`;
export const log = (bot: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), bot, msg, ...extra }));
