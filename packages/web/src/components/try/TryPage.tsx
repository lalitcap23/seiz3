"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL, useSnapshot } from "@/lib/api";
import { useMe } from "@/lib/me";
import { useWallet, WalletProvider } from "@/lib/wallet";
import { BorrowCard } from "./BorrowCard";
import { SwapCard } from "./SwapCard";
import { TxStatus } from "./ui";
import { VaultCard } from "./VaultCard";
import { FaucetCard, WalletBar } from "./WalletBar";

function Cards() {
  const { address } = useWallet();
  const { data: me } = useMe(address);
  const qc = useQueryClient();
  const { data: snapshot } = useSnapshot();
  // the API's snapshot arrives every second over SSE; when something that touches this wallet changed (a vault event,
  // the vault's stock, this address's collateral or health), re-read the wallet's balances and position right away.
  // Not debt: interest moves it every second, and the browser shares the public RPC's rate limit.
  const marketC = snapshot?.markets.find((m) => m.name === "C_afterbell");
  const myRow = marketC?.borrowers?.find((b) => b.address.toLowerCase() === address?.toLowerCase());
  const changed = snapshot
    ? [
        snapshot.activity.length,
        snapshot.activity.at(-1)?.txHash,
        snapshot.vault.inventory,
        myRow?.collateral,
        myRow?.healthy,
      ].join("|")
    : "";
  useEffect(() => {
    if (changed !== "") void qc.invalidateQueries({ queryKey: ["me"] });
  }, [changed, qc]);
  // from now on the keeper checks this address every tick, whether or not its Borrow event gets scanned
  useEffect(() => {
    if (address === null) return;
    void fetch(`${API_URL}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    }).catch(() => undefined);
  }, [address]);
  return (
    <div className="grid gap-4 pb-20 md:grid-cols-2">
      <WalletBar me={me} />
      <FaucetCard me={me} />
      <BorrowCard me={me} />
      <div className="flex flex-col gap-4">
        <VaultCard me={me} />
        <SwapCard me={me} />
      </div>
      <TxStatus />
    </div>
  );
}

export function TryPage() {
  return (
    <WalletProvider>
      <Cards />
    </WalletProvider>
  );
}
