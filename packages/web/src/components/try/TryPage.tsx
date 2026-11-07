"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL, useSnapshot } from "@/lib/api";
import { CHAIN_LABEL, dep } from "@/lib/chain";
import { useMe } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { useJourney, type Role, type StepKey } from "./journey";
import { LoanTimeline } from "./LoanTimeline";
import { NextStep, Progress } from "./NextStep";
import { Roles } from "./Roles";
import { TxStatus } from "./ui";
import { WalletPanel } from "./WalletPanel";

export function TryPage() {
  const { address, hasWallet, onChain } = useWallet();
  const { data: me, isRefetchError, dataUpdatedAt } = useMe(address);
  const qc = useQueryClient();
  const { data: snapshot } = useSnapshot();
  const operations = snapshot?.operations ?? [];
  // the API's snapshot arrives every second over SSE; when something that touches this wallet changed (a vault event,
  // the vault's stock, this address's collateral or health), re-read the wallet's balances and position right away.
  // Not debt: interest moves it every second, and the browser shares the public RPC's rate limit.
  const marketC = snapshot?.markets.find((m) => m.name === "C_seiz3");
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

  const journey = useJourney({ hasWallet, address, onChain, me, operations });
  // a step opened from the tabs; it lasts until the wallet moves on to another step (or "back to your next step")
  const [view, setView] = useState<{ step: StepKey; at: StepKey } | null>(null);
  const shown = view !== null && view.at === journey.step ? view.step : journey.step;
  const go = (step?: StepKey) => setView(step === undefined || step === journey.step ? null : { step, at: journey.step });
  const [role, setRole] = useState<Role | null>(null);
  const rolesRef = useRef<HTMLDivElement>(null);
  function openRole(r: Role) {
    setRole(r);
    rolesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="flex flex-col gap-3 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-1 pt-1">
        <div className="flex max-w-[78ch] flex-col gap-1">
          <h1 className="text-[20px] font-semibold tracking-tight">Try Seiz3 as a borrower</h1>
          <p className="text-[13px] leading-relaxed text-muted">
            Borrow USDC against tokenized NVIDIA stock, get liquidated, then watch Seiz3&apos;s vault take the stock, hedge it
            on HyperCore and sell it back through a Uniswap v4 hook. Test tokens on {CHAIN_LABEL}; follow the steps.
          </p>
        </div>
        <Link href="/" className="font-mono text-[11px] text-faint hover:text-foreground">
          The whole system: Dashboard →
        </Link>
      </div>
      <Progress current={journey.step} selected={shown} onSelect={go} />
      {/* react-query keeps the last good read when a refetch fails: say so, or a stale loan looks live */}
      {me && isRefetchError && (
        <p className="rounded-[3px] border border-warn/40 bg-warn/5 px-3 py-2 font-mono text-[11px] text-warn">
          {CHAIN_LABEL} RPC isn&apos;t answering (rate limit?): your balances and loan are from{" "}
          {new Date(dataUpdatedAt).toLocaleTimeString()}. Retrying every 5 s.
        </p>
      )}
      <div className="grid items-start gap-3 lg:grid-cols-12">
        <div className="flex flex-col gap-3 lg:col-span-8">
          <NextStep
            me={me}
            journey={journey}
            step={shown}
            operations={operations}
            readAt={dataUpdatedAt}
            go={go}
            onRole={openRole}
          />
          {address && <LoanTimeline operations={operations} address={address} szDecimals={dep.hypercore.szDecimals} />}
        </div>
        <div className="flex flex-col gap-3 lg:col-span-4">
          <WalletPanel me={me} step={journey.step} />
          <div ref={rolesRef} className="scroll-mt-16">
            <Roles me={me} role={role} onRole={setRole} />
          </div>
        </div>
      </div>
      <TxStatus />
    </div>
  );
}
