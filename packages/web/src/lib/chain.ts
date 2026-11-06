import { createPublicClient, http, type PublicClient } from "viem";
import { hyperEvm, hyperliquidEvmTestnet } from "viem/chains";
import { getDeployment } from "@afterbell/shared/deployments";
import type { Network } from "@afterbell/shared";

/** The tester page runs against one network: testnet unless NEXT_PUBLIC_NETWORK says otherwise. */
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as Network;
// from this package's viem, not @afterbell/shared's: the two resolve to different copies
export const chain = NETWORK === "mainnet" ? hyperEvm : hyperliquidEvmTestnet;
export const dep = getDeployment(NETWORK);
export const publicClient = createPublicClient({
  chain,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0]), // "" (an unset build arg) too
}) as PublicClient;

/** Our own transaction page (app/tx/[hash]): HyperEVM testnet has no public explorer that resolves these. */
export const EXPLORER_TX = "/tx/";
