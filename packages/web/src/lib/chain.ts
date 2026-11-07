import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { deploymentSchema } from "@seiz3/shared/deployments";
import type { Network } from "@seiz3/shared";

/** The page runs against one network. */
export const NETWORK: Network = "base-sepolia";
// from this package's viem, not @seiz3/shared's: the two resolve to different copies
export const chain = baseSepolia;
// next.config.ts hands the deployment file over at build time (deployments/ is git-ignored)
const injected = process.env.NEXT_PUBLIC_DEPLOYMENT_JSON;
if (!injected) throw new Error("NEXT_PUBLIC_DEPLOYMENT_JSON is not set: build with DEPLOYMENTS_PATH or deployments/base-sepolia.json");
const raw = JSON.parse(injected) as Record<string, unknown>;
export const dep = deploymentSchema.parse(raw);

const optAddress = (key: string): Address | undefined => {
  const v = raw[key];
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
};
/** Addresses the shared schema leaves out, for the How it works page's contract list. */
export const extraAddresses = {
  poolSeeder: optAddress("poolSeeder"),
  naiveLiquidator: optAddress("naiveLiquidator"),
  creForwarder: optAddress("creForwarder"),
};
export const publicClient = createPublicClient({
  chain,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0]), // "" (an unset build arg) too
}) as PublicClient;

/** The EVM chain the vault lives on, for labels. */
export const EVM_NAME = "Base";
/** The network to switch a wallet to, in words. */
export const CHAIN_LABEL = "Base Sepolia";
/** The gas token. */
export const GAS = chain.nativeCurrency.symbol;

/** The public explorer for the vault's chain. */
export const EVM_EXPLORER = "https://sepolia.basescan.org";

/** Where a transaction on the vault's chain opens. */
export function evmTxUrl(hash: string): string {
  return `${EVM_EXPLORER}/tx/${hash}`;
}

/** Hyperliquid's explorer: HyperCore transactions (the hedge account's orders and fills). */
const HL_EXPLORER = "https://app.hyperliquid-testnet.xyz/explorer";
export const HL_EXPLORER_TX = `${HL_EXPLORER}/tx/`;

/** The HyperCore account that holds the short: the relayer's hedge account. */
export const CORE_ACCOUNT = dep.hedgeAccount;
export const HL_ACCOUNT_URL = `${HL_EXPLORER}/address/${CORE_ACCOUNT}`;
