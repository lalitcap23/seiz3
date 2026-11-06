import { baseSepolia, hyperEvm, hyperliquidEvmTestnet } from "viem/chains";
import type { Chain } from "viem";

/** testnet / mainnet: HyperEVM. base-sepolia: the vault on Base Sepolia, its short on HyperCore testnet (relayer). */
export type Network = "testnet" | "mainnet" | "base-sepolia";

export const chains: Record<Network, Chain> = {
  testnet: hyperliquidEvmTestnet,
  mainnet: hyperEvm,
  "base-sepolia": baseSepolia,
};

export const HL_INFO_API: Record<Network, string> = {
  testnet: "https://api.hyperliquid-testnet.xyz/info",
  mainnet: "https://api.hyperliquid.xyz/info",
  "base-sepolia": "https://api.hyperliquid-testnet.xyz/info", // the hedge account trades HyperCore testnet
};
