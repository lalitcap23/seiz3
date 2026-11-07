"use client";

import { useState, type ReactNode } from "react";
import { API_URL } from "@/lib/api";
import { dep, EVM_NAME, evmTxUrl, GAS } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Label, Tag } from "../ui";
import { DUST, type StepKey } from "./journey";
import { Card, Rows, fmt } from "./ui";

/** The faucet: the API's operator key sends the drip, so a brand-new wallet with no gas can start. */
export function useFaucet(me: Me | undefined) {
  const { address } = useWallet();
  const [status, setStatus] = useState<{ text: string; hash?: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const waitUntil = me && me.nextDripAt > Number(me.now) ? me.nextDripAt : 0;

  async function drip() {
    setBusy(true);
    setStatus({ text: "Sending…" });
    try {
      const res = await fetch(`${API_URL}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json()) as { hash?: string; error?: string };
      setStatus(
        res.ok
          ? { text: "Sent. Tokens show up in a few seconds.", hash: body.hash }
          : { text: body.error ?? `error ${res.status}`, error: true },
      );
    } catch (error) {
      setStatus({ text: String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return { deployed: dep.faucet !== undefined, waitUntil, busy, status, drip, disabled: address === null || busy || waitUntil > 0 };
}

export function FaucetStatus({ status }: { status: ReturnType<typeof useFaucet>["status"] }) {
  if (status === null) return null;
  return (
    <p className={`font-mono text-[11px] ${status.error ? "text-down" : "text-muted"}`}>
      {status.text}{" "}
      {status.hash && (
        <a className="text-faint underline hover:text-foreground" href={evmTxUrl(status.hash)} target="_blank" rel="noreferrer">
          view
        </a>
      )}
    </p>
  );
}

/** Everything this wallet holds, in one place: balances, then what it has in each market. */
export function WalletPanel({ me, step }: { me: Me | undefined; step: StepKey }) {
  const { address, onChain } = useWallet();
  const faucet = useFaucet(me);
  if (address === null) return null;

  const positions: [string, ReactNode][] = [];
  if (me) {
    const p = me.position;
    if (p.collateral > 0n) positions.push(["Collateral · Morpho", `${fmt(p.collateral, 18)} NVDAx`]);
    if (p.debt >= DUST) positions.push(["Loan · Morpho", `${fmt(p.debt, 6, 4)} USDC`]);
    if (me.lend.shares > 0n) positions.push(["Lent · Morpho", `${fmt(me.lend.value, 6, 2)} USDC`]);
    if (me.vault.shares > 0n) positions.push(["Vault LP", `${fmt(me.vault.value, 6, 2)} USDC`]);
    if (me.vault.queued > 0n) positions.push(["Vault withdrawal queued", `${fmt(me.vault.queuedValue, 6, 2)} USDC`]);
  }

  return (
    <Card title="Your wallet" meta={onChain ? <Tag tone="up">{EVM_NAME}</Tag> : <Tag tone="warn">wrong chain</Tag>}>
      <p className="truncate font-mono text-[12px] text-muted" title={address}>
        {address}
      </p>
      {me && (
        <Rows
          rows={[
            [
              `${GAS} (gas)`,
              <span key="gas" className={me.hype === 0n ? "text-warn" : ""}>
                {fmt(me.hype, 18, 5)}
              </span>,
            ],
            ["USDC", fmt(me.usdc, 6, 2)],
            ["NVDAx", fmt(me.nvdax, 18)],
          ]}
        />
      )}
      {positions.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <Label>In the markets</Label>
          <Rows rows={positions} />
        </div>
      )}
      {/* the faucet is its own step at the start; after that, a quiet top-up */}
      {faucet.deployed && step !== "faucet" && step !== "connect" && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => void faucet.drip()}
            disabled={faucet.disabled}
            className="self-start font-mono text-[11px] text-brand hover:underline disabled:cursor-not-allowed disabled:text-faint disabled:no-underline"
          >
            {faucet.waitUntil
              ? `Faucet: next drip ${new Date(faucet.waitUntil * 1000).toLocaleString()}`
              : "Need more? Get test tokens →"}
          </button>
          <FaucetStatus status={faucet.status} />
        </div>
      )}
    </Card>
  );
}
