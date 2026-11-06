"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  createWalletClient,
  custom,
  numberToHex,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { chain, publicClient } from "./chain";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface TxState {
  label: string;
  status: "signing" | "pending" | "done" | "failed";
  hash?: Hex;
  error?: string;
}

interface Wallet {
  address: Address | null;
  hasWallet: boolean;
  onChain: boolean;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  /** Sends one contract call from the connected account and waits for it; the latest is in `tx`. */
  write: (label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => Promise<boolean>;
  tx: TxState | null;
}

const WalletContext = createContext<Wallet | null>(null);
const noSubscribe = () => () => {};

/** An injected wallet (MetaMask, Rabby, …) on HyperEVM; no WalletConnect, no wallet library. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const hasWallet = useSyncExternalStore(noSubscribe, () => window.ethereum !== undefined, () => false);
  const [tx, setTx] = useState<TxState | null>(null);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    const onAccounts = (accounts: string[]) => setAddress((accounts[0] as Address | undefined) ?? null);
    const onChain = (id: string) => setChainId(Number(id));
    void eth.request({ method: "eth_accounts" }).then(onAccounts);
    void eth.request({ method: "eth_chainId" }).then(onChain);
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener("accountsChanged", onAccounts);
      eth.removeListener("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const accounts = await window.ethereum?.request({ method: "eth_requestAccounts" });
    setAddress((accounts?.[0] as Address | undefined) ?? null);
  }, []);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const id = numberToHex(chain.id);
    const add = {
      chainId: id,
      chainName: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: [...chain.rpcUrls.default.http],
      blockExplorerUrls: chain.blockExplorers?.default
        ? [chain.blockExplorers.default.url]
        : undefined,
    };
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    } catch (error) {
      // 4902 / -32603 (MetaMask): chain unknown → add it, then switch again.
      const code = (error as { code?: number }).code;
      if (code === 4001) throw error; // user rejected; don't stack a second prompt
      await eth.request({ method: "wallet_addEthereumChain", params: [add] });
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    }
  }, []);

  const write = useCallback<Wallet["write"]>(
    async (label, to, abi, functionName, args) => {
      const eth = window.ethereum;
      if (!eth || !address) return false;
      setTx({ label, status: "signing" });
      try {
        const wallet = createWalletClient({ account: address, chain, transport: custom(eth) });
        // simulate first: a revert shows its reason here instead of as a failed transaction
        const { request } = await publicClient.simulateContract({ account: address, address: to, abi, functionName, args } as never);
        const hash = await wallet.writeContract(request as never);
        setTx({ label, status: "pending", hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const ok = receipt.status === "success";
        setTx({ label, status: ok ? "done" : "failed", hash, ...(ok ? {} : { error: "reverted" }) });
        await qc.invalidateQueries({ queryKey: ["me"] });
        return ok;
      } catch (error) {
        const e = error as { shortMessage?: string; message?: string };
        setTx({ label, status: "failed", error: e.shortMessage ?? e.message?.split("\n")[0] ?? String(error) });
        return false;
      }
    },
    [address, qc],
  );

  return (
    <WalletContext.Provider
      value={{ address, hasWallet, onChain: chainId === chain.id, connect, switchChain, write, tx }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (w === null) throw new Error("useWallet outside WalletProvider");
  return w;
}
