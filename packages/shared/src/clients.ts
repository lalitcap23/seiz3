import type { Network } from "./chains.js";

export function rpcUrlFor(network: Network): string | undefined {
  return network === "mainnet"
    ? process.env.HYPEREVM_RPC_URL
    : process.env.HYPEREVM_TESTNET_RPC_URL;
}
