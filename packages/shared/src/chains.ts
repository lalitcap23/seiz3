import { baseSepolia } from "viem/chains";
import type { Chain } from "viem";

/** base-sepolia: the vault on Base Sepolia, its short on HyperCore testnet (relayer). */
export type Network = "base-sepolia";

export const chains: Record<Network, Chain> = {
  "base-sepolia": baseSepolia,
};

export const HL_INFO_API: Record<Network, string> = {
  "base-sepolia": "https://api.hyperliquid-testnet.xyz/info", // the hedge account trades HyperCore testnet
};
