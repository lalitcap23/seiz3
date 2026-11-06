"use client";

import { useEffect } from "react";
import { API_URL } from "@/lib/api";
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
