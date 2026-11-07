import type { ReactNode } from "react";
import { evmTxUrl } from "@/lib/chain";
import { shortHash } from "@/lib/format";

/** A terminal panel: a header bar (uppercase title, optional meta on the right), then the body. */
export function Panel({
  title,
  meta,
  accent,
  className = "",
  bodyClassName = "p-3",
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** A brand line along the top: the panel the eye should go to first. */
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-[3px] border border-line bg-panel ${
        accent ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""
      } ${className}`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="flex min-w-0 items-center gap-2 truncate font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          {title}
        </h2>
        {meta && <div className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">{meta}</div>}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[10px] uppercase tracking-[0.08em] text-muted ${className}`}>{children}</span>;
}

/** A label over a figure. */
export function Stat({
  label,
  value,
  sub,
  tone = "",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <Label>{label}</Label>
      <span className={`truncate font-mono text-[13px] ${tone}`}>{value}</span>
      {sub && <span className="truncate font-mono text-[11px] text-faint">{sub}</span>}
    </div>
  );
}

const TAG_TONES = {
  up: "bg-up/12 text-up",
  down: "bg-down/12 text-down",
  warn: "bg-warn/12 text-warn",
  brand: "bg-brand/12 text-brand",
  evm: "bg-evm/12 text-evm",
  core: "bg-core/12 text-core",
  muted: "bg-foreground/6 text-muted",
} as const;

export type Tone = keyof typeof TAG_TONES;

export function Tag({ tone = "muted", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[2px] px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${TAG_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Label/value rows, values right-aligned in mono. */
export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="flex flex-col">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 border-b border-line/70 py-[7px] last:border-b-0">
          <dt className="text-[12px] text-muted">{k}</dt>
          <dd className="min-w-0 truncate text-right font-mono text-[12px]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A thin bar, `value` from 0 to 1. */
export function Meter({ value, tone, className = "" }: { value: number; tone: string; className?: string }) {
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-line-strong ${className}`}>
      <div className={`h-full ${tone}`} style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
    </div>
  );
}

/** A transaction on the vault's chain, opened on Basescan. */
export function TxLink({ hash, className = "" }: { hash: string; className?: string }) {
  const cls = `shrink-0 font-mono text-[11px] text-faint hover:text-foreground ${className}`;
  return (
    <a href={evmTxUrl(hash)} target="_blank" rel="noreferrer" className={cls} title="Open on Basescan">
      {shortHash(hash)} ↗
    </a>
  );
}

/** Something on HyperCore (a fill, or the account that holds the short), opened on Hyperliquid's explorer. */
export function CoreLink({ href, label, className = "" }: { href: string; label: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open on Hyperliquid's explorer"
      className={`shrink-0 font-mono text-[11px] text-faint hover:text-foreground ${className}`}
    >
      {label} ↗
    </a>
  );
}
