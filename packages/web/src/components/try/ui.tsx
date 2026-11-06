"use client";

import { useState, type ReactNode } from "react";
import { formatUnits, parseUnits } from "viem";
import { EXPLORER_TX } from "@/lib/chain";
import { useWallet } from "@/lib/wallet";
import { shortHash } from "@/lib/format";
import { KV, Panel } from "../ui";

export function Card({ title, meta, hint, children }: { title: ReactNode; meta?: ReactNode; hint?: string; children?: ReactNode }) {
  return (
    <Panel title={title} meta={meta} bodyClassName="flex flex-col gap-3 p-3">
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
      {children}
    </Panel>
  );
}

export function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return <KV rows={rows} />;
}

/** A form section's heading: step number and name on the left, context (a balance, a limit) on the right. */
export function Section({ step, title, aside }: { step?: string; title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      {step && <span className="font-mono text-[11px] text-brand">{step}</span>}
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-foreground">{title}</span>
      {aside && <span className="ml-auto font-mono text-[11px] text-faint">{aside}</span>}
    </div>
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
    <div className="flex h-10 items-center gap-2 rounded-[3px] border border-line-strong bg-well px-3 focus-within:border-brand/50">
      <input
        inputMode="decimal"
        placeholder="0.00"
        value={amount.text}
        onChange={(e) => amount.setText(e.target.value)}
        className="min-w-0 flex-1 bg-transparent font-mono text-[14px] outline-none placeholder:text-faint"
      />
      {max && (
        <button
          type="button"
          onClick={() => amount.setValue(max.value > 0n ? max.value : 0n)}
          className="rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-brand hover:bg-brand/10"
        >
          {max.label ?? "Max"}
        </button>
      )}
      <span className="font-mono text-[11px] text-muted">{unit}</span>
    </div>
  );
}

const ACTION_TONES = {
  primary: "bg-brand text-black hover:bg-brand/90",
  plain: "border border-line-strong text-foreground hover:bg-raised",
  up: "bg-up text-black hover:bg-up/90",
  down: "bg-down text-white hover:bg-down/90",
} as const;

export function Action({
  label,
  onClick,
  disabled,
  tone = "primary",
  className = "",
}: {
  label: string;
  onClick: () => void | Promise<unknown>;
  disabled?: boolean;
  tone?: keyof typeof ACTION_TONES;
  className?: string;
}) {
  const { tx } = useWallet();
  const busy = tx?.status === "signing" || tx?.status === "pending";
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => void onClick()}
      className={`h-9 rounded-[3px] px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:border-transparent disabled:bg-raised disabled:text-faint ${ACTION_TONES[tone]} ${className}`}
    >
      {label}
    </button>
  );
}

/** A small explanation set apart from the form. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="border-l-2 border-line-strong pl-2.5 text-[11.5px] leading-relaxed text-muted">{children}</p>;
}

/** The latest transaction from this page, as a toast in the corner. */
export function TxStatus() {
  const { tx } = useWallet();
  if (tx === null) return null;
  const { text, dot, tone } = {
    signing: { text: "Confirm in your wallet…", dot: "bg-warn animate-pulse-dot", tone: "text-muted" },
    pending: { text: "Waiting for the block…", dot: "bg-warn animate-pulse-dot", tone: "text-muted" },
    done: { text: "Confirmed", dot: "bg-up", tone: "text-up" },
    failed: { text: tx.error ?? "Failed", dot: "bg-down", tone: "text-down" },
  }[tx.status];
  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(360px,calc(100vw-2rem))] rounded-[3px] border border-line-strong bg-raised shadow-2xl shadow-black/60">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className={`size-1.5 rounded-full ${dot}`} />
        <span className="text-[12px] font-medium">{tx.label}</span>
        {tx.hash && (
          <a className="ml-auto font-mono text-[11px] text-faint hover:text-foreground" href={`${EXPLORER_TX}${tx.hash}`} target="_blank" rel="noreferrer">
            {shortHash(tx.hash)} ↗
          </a>
        )}
      </div>
      <p className={`border-t border-line px-3 py-2 font-mono text-[11px] break-words ${tone}`}>{text}</p>
    </div>
  );
}

export const fmt = (v: bigint, decimals: number, digits = 4) =>
  Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: digits });
