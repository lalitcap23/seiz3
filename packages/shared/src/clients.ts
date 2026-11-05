import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chains, type Network } from "./chains.js";

export function makePublicClient(network: Network, rpcUrl?: string) {
  return createPublicClient({ chain: chains[network], transport: http(rpcUrl) });
}

export function makeWalletClient(network: Network, privateKey: Hex, rpcUrl?: string) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chains[network],
    transport: http(rpcUrl),
  });
}

export function rpcUrlFor(network: Network): string | undefined {
  return network === "mainnet"
    ? process.env.HYPEREVM_RPC_URL
    : process.env.HYPEREVM_TESTNET_RPC_URL;
}
