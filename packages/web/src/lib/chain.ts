import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia, hyperEvm, hyperliquidEvmTestnet } from "viem/chains";
import { deploymentSchema, getDeployment } from "@seiz3/shared/deployments";
import type { Network } from "@seiz3/shared";

/** The tester page runs against one network: testnet unless NEXT_PUBLIC_NETWORK says otherwise. */
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as Network;
// from this package's viem, not @seiz3/shared's: the two resolve to different copies
export const chain = NETWORK === "mainnet" ? hyperEvm : NETWORK === "base-sepolia" ? baseSepolia : hyperliquidEvmTestnet;
// Base Sepolia's deployment file isn't bundled by @seiz3/shared: next.config.ts hands it over at build time
const injected = process.env.NEXT_PUBLIC_DEPLOYMENT_JSON;
export const dep = injected ? deploymentSchema.parse(JSON.parse(injected)) : getDeployment(NETWORK);
export const publicClient = createPublicClient({
  chain,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0]), // "" (an unset build arg) too
}) as PublicClient;

/** The EVM chain the vault lives on, for labels ("HyperEVM", or "Base" for the Base Sepolia deployment). */
export const EVM_NAME = NETWORK === "base-sepolia" ? "Base" : "HyperEVM";
/** The network to switch a wallet to, in words. */
export const CHAIN_LABEL = NETWORK === "base-sepolia" ? "Base Sepolia" : NETWORK === "mainnet" ? "HyperEVM" : "HyperEVM testnet";
/** The gas token: HYPE on HyperEVM, ETH on Base. */
export const GAS = chain.nativeCurrency.symbol;

/** Our own transaction page (app/tx/[hash]): HyperEVM testnet has no public explorer that resolves these. */
export const EXPLORER_TX = "/tx/";

/** A public explorer for the vault's chain, where there is one: Basescan on Base Sepolia. Null on HyperEVM. */
export const EVM_EXPLORER = NETWORK === "base-sepolia" ? "https://sepolia.basescan.org" : null;

/** Where a transaction on the vault's chain opens: Basescan on Base Sepolia, our decoder page on HyperEVM. */
export function evmTxUrl(hash: string): string {
  return EVM_EXPLORER ? `${EVM_EXPLORER}/tx/${hash}` : `${EXPLORER_TX}${hash}`;
}

/** Hyperliquid's explorer: HyperCore transactions (the vault's orders and fills), not HyperEVM ones. */
const HL_EXPLORER = NETWORK === "mainnet" ? "https://app.hyperliquid.xyz/explorer" : "https://app.hyperliquid-testnet.xyz/explorer";
export const HL_EXPLORER_TX = `${HL_EXPLORER}/tx/`;

/** The HyperCore account that holds the short: the vault itself on HyperEVM, the relayer's hedge account on Base. */
export const CORE_ACCOUNT = dep.hedgeAccount ?? dep.vault;
export const HL_ACCOUNT_URL = `${HL_EXPLORER}/address/${CORE_ACCOUNT}`;
