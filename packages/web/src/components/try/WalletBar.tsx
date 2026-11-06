"use client";

import { useState } from "react";
import { API_URL } from "@/lib/api";
import { dep, EXPLORER_TX } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, Card, Rows, fmt } from "./ui";

export function WalletBar({ me }: { me: Me | undefined }) {
  const { address, hasWallet, onChain, connect, switchChain } = useWallet();

  if (!hasWallet) {
    return <Card title="Wallet" hint="Install MetaMask or Rabby to try Afterbell on HyperEVM testnet." />;
  }
  if (address === null) {
    return (
      <Card title="Wallet" hint="Connect a wallet to borrow, provide liquidity or swap on HyperEVM testnet.">
        <Action label="Connect wallet" onClick={connect} />
      </Card>
    );
  }
  return (
    <Card title="Wallet" hint={address}>
      {!onChain && <Action label="Switch to HyperEVM testnet" onClick={switchChain} />}
      {me && (
        <Rows
          rows={[
            ["HYPE (gas)", fmt(me.hype, 18, 5)],
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
    <Card title="Faucet" hint="Test NVDAx to borrow against, a little USDC, and HYPE for gas. One drip per address per cooldown (the button shows when the next is due).">
      <Action
        label={waitUntil ? `Next drip ${new Date(waitUntil * 1000).toLocaleString()}` : "Get test tokens"}
        onClick={drip}
        disabled={address === null || busy || waitUntil > 0}
      />
      {state && (
        <p className={`text-xs ${state.error ? "text-red-500" : "opacity-70"}`}>
          {state.text}{" "}
          {state.hash && (
            <a className="underline" href={`${EXPLORER_TX}${state.hash}`} target="_blank" rel="noreferrer">
              view
            </a>
          )}
        </p>
      )}
    </Card>
  );
}
