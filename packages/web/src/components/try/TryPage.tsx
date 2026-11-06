"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "@afterbell/shared";
import { API_URL, useSnapshot } from "@/lib/api";
import { dep } from "@/lib/chain";
import { useMe, type Me } from "@/lib/me";
import { useWallet, WalletProvider } from "@/lib/wallet";
import { StatusBar } from "../StatusBar";
import { BorrowCard } from "./BorrowCard";
import { LoanTimeline } from "./LoanTimeline";
import { SwapCard } from "./SwapCard";
import { TxStatus } from "./ui";
import { VaultCard } from "./VaultCard";
import { FaucetCard, WalletBar } from "./WalletBar";

const STEPS = [
  ["Get test tokens", "Faucet drips NVDAx, USDC and HYPE for gas"],
  ["Deposit NVDAx", "Collateral on Morpho Market C"],
  ["Borrow to the limit", "Max leaves ~15 s of interest before it tips over"],
  ["Get liquidated", "The vault buys your NVDAx and shorts it on HyperCore"],
] as const;

/** The walkthrough, ticked off from this wallet's own state. */
function Steps({ me, snapshot, address }: { me: Me | undefined; snapshot: Snapshot | undefined; address: string | null }) {
  const liquidated =
    address !== null &&
    (snapshot?.operations ?? []).some((o) => o.kind === "liquidation" && o.borrower?.toLowerCase() === address.toLowerCase());
  const done = [
    liquidated || (!!me && (me.nvdax > 0n || me.position.collateral > 0n)),
    liquidated || (!!me && me.position.collateral > 0n),
    liquidated || (!!me && me.position.debt > 0n),
    liquidated,
  ];
  const current = address === null ? -1 : done.indexOf(false);
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-line bg-line lg:grid-cols-4">
      {STEPS.map(([title, text], i) => (
        <li
          key={title}
          className={`flex gap-3 px-4 py-3 ${i === current ? "bg-raised shadow-[inset_0_2px_0_var(--color-brand)]" : "bg-panel"}`}
        >
          <span
            className={`font-mono text-[12px] font-semibold ${done[i] ? "text-up" : i === current ? "text-brand" : "text-faint"}`}
          >
            {done[i] ? "✓" : `0${i + 1}`}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={`text-[13px] font-medium ${done[i] || i === current ? "text-foreground" : "text-muted"}`}>{title}</span>
            <span className="text-[11px] text-faint">{text}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

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
    <div className="flex flex-col gap-2 pb-24">
      {snapshot && <StatusBar data={snapshot} />}
      <Steps me={me} snapshot={snapshot} address={address} />
      <div className="grid items-start gap-2 lg:grid-cols-12">
        <div className="flex flex-col gap-2 lg:col-span-3">
          <WalletBar me={me} />
          <FaucetCard me={me} />
        </div>
        <div className="lg:col-span-5">
          <BorrowCard me={me} />
        </div>
        <div className="flex flex-col gap-2 lg:col-span-4">
          <VaultCard me={me} />
          <SwapCard me={me} />
        </div>
      </div>
      {snapshot && address && (
        <LoanTimeline operations={snapshot.operations ?? []} address={address} szDecimals={dep.hypercore.szDecimals} />
      )}
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
