import { hyperEvm, hyperliquidEvmTestnet } from "viem/chains";
import type { Chain } from "viem";

export type Network = "testnet" | "mainnet";

export const chains: Record<Network, Chain> = {
  testnet: hyperliquidEvmTestnet,
  mainnet: hyperEvm,
};

export const HL_INFO_API: Record<Network, string> = {
  testnet: "https://api.hyperliquid-testnet.xyz/info",
  mainnet: "https://api.hyperliquid.xyz/info",
};
