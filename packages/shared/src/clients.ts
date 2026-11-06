import type { Network } from "./chains.js";

export function rpcUrlFor(network: Network): string | undefined {
  if (network === "base-sepolia") return process.env.BASE_SEPOLIA_RPC_URL;
  return network === "mainnet"
    ? process.env.HYPEREVM_RPC_URL
    : process.env.HYPEREVM_TESTNET_RPC_URL;
}
