"use client";

import { useState, type ReactNode } from "react";
import { formatUnits, parseUnits } from "viem";
import { EXPLORER_TX } from "@/lib/chain";
import { useWallet } from "@/lib/wallet";
import { shortHash } from "@/lib/format";

export function Card({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-foreground/10 p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="text-xs opacity-60">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-y-1 text-sm tabular-nums">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="opacity-60">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A token amount: the text the person typed, parsed to base units (null while it isn't a number). */
export function useAmount(decimals: number) {
  const [text, setText] = useState("");
  let value: bigint | null = null;
  try {
    value = text.trim() === "" ? null : parseUnits(text.trim(), decimals);
  } catch {
    value = null;
  }
  return { text, setText, value, setValue: (v: bigint) => setText(formatUnits(v, decimals)) };
}

export function AmountInput({
  amount,
  unit,
  max,
}: {
  amount: ReturnType<typeof useAmount>;
  unit: string;
  max?: { value: bigint; label?: string };
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-foreground/15 px-3 py-2">
      <input
        inputMode="decimal"
        placeholder="0.0"
        value={amount.text}
        onChange={(e) => amount.setText(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none"
      />
      <span className="text-xs opacity-60">{unit}</span>
      {max && (
        <button
          type="button"
          onClick={() => amount.setValue(max.value > 0n ? max.value : 0n)}
          className="rounded bg-foreground/10 px-2 py-0.5 text-xs font-medium"
        >
          {max.label ?? "Max"}
        </button>
      )}
    </div>
  );
}

export function Action({
  label,
  onClick,
  disabled,
  tone = "primary",
}: {
  label: string;
  onClick: () => void | Promise<unknown>;
  disabled?: boolean;
  tone?: "primary" | "plain";
}) {
  const { tx } = useWallet();
  const busy = tx?.status === "signing" || tx?.status === "pending";
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => void onClick()}
      className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40 ${
        tone === "primary" ? "bg-emerald-500 text-white" : "bg-foreground/10"
      }`}
    >
      {label}
    </button>
  );
}

/** The latest transaction from this page, pinned to the bottom. */
export function TxStatus() {
  const { tx } = useWallet();
  if (tx === null) return null;
  const text = {
    signing: "confirm in your wallet…",
    pending: "waiting for the block…",
    done: "done",
    failed: tx.error ?? "failed",
  }[tx.status];
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-foreground/10 bg-background/95 px-4 py-3 text-sm backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3">
        <span className="font-medium">{tx.label}</span>
        <span className={tx.status === "failed" ? "text-red-500" : tx.status === "done" ? "text-emerald-500" : "opacity-70"}>
          {text}
        </span>
        {tx.hash && (
          <a className="ml-auto underline opacity-70" href={`${EXPLORER_TX}${tx.hash}`} target="_blank" rel="noreferrer">
            {shortHash(tx.hash)}
          </a>
        )}
      </div>
    </div>
  );
}

export const fmt = (v: bigint, decimals: number, digits = 4) =>
  Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: digits });
