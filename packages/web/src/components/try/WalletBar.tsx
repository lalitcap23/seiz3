"use client";

import { useState } from "react";
import { API_URL } from "@/lib/api";
import { CHAIN_LABEL, dep, EVM_NAME, evmTxUrl, GAS } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Tag } from "../ui";
import { Action, Card, Rows, fmt } from "./ui";

export function WalletBar({ me }: { me: Me | undefined }) {
  const { address, hasWallet, onChain, connect, switchChain } = useWallet();

  if (!hasWallet) {
    return <Card title="Account" hint={`Install MetaMask or Rabby to try Afterbell on ${CHAIN_LABEL}.`} />;
  }
  if (address === null) {
    return (
      <Card title="Account" hint={`Connect a wallet to lend, borrow, provide liquidity or swap on ${CHAIN_LABEL}.`}>
        <Action label="Connect wallet" onClick={connect} className="w-full" />
      </Card>
    );
  }
  return (
    <Card title="Account" meta={onChain ? <Tag tone="up">{EVM_NAME}</Tag> : <Tag tone="warn">wrong chain</Tag>}>
      <p className="truncate font-mono text-[12px]" title={address}>
        {address}
      </p>
      {!onChain && <Action label={`Switch to ${CHAIN_LABEL}`} onClick={switchChain} className="w-full" />}
      {me && (
        <Rows
          rows={[
            [`${GAS} (gas)`, fmt(me.hype, 18, 5)],
            ["USDC", fmt(me.usdc, 6, 2)],
            ["NVDAx", fmt(me.nvdax, 18)],
          ]}
        />
      )}
    </Card>
  );
}

/** The API's operator key sends the drip, so a brand-new wallet with no gas can start. */
export function FaucetCard({ me }: { me: Me | undefined }) {
  const { address } = useWallet();
  const [state, setState] = useState<{ text: string; hash?: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!dep.faucet) return <Card title="Faucet" hint="Not deployed on this network yet." />;
  const waitUntil = me && me.nextDripAt > Number(me.now) ? me.nextDripAt : 0;

  async function drip() {
    setBusy(true);
    setState({ text: "sending…" });
    try {
      const res = await fetch(`${API_URL}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json()) as { hash?: string; error?: string };
      setState(res.ok ? { text: "sent", hash: body.hash } : { text: body.error ?? `error ${res.status}`, error: true });
    } catch (error) {
      setState({ text: String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Faucet"
      meta={<span>1 drip / cooldown</span>}
      hint={`Test NVDAx to borrow against, USDC to lend or buy with, and ${GAS} for gas.`}
    >
      <Action
        label={waitUntil ? `Next drip ${new Date(waitUntil * 1000).toLocaleString()}` : "Get test tokens"}
        onClick={drip}
        disabled={address === null || busy || waitUntil > 0}
        className="w-full"
      />
      {state && (
        <p className={`font-mono text-[11px] ${state.error ? "text-down" : "text-muted"}`}>
          {state.text}{" "}
          {state.hash && (
            <a className="text-faint underline hover:text-foreground" href={evmTxUrl(state.hash)} target="_blank" rel="noreferrer">
              view
            </a>
          )}
        </p>
      )}
    </Card>
  );
}
