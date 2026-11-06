"use client";

import { useEffect, useRef, useState } from "react";
import { useCachedSnapshot } from "@/lib/api";
import { CHAIN_LABEL, EVM_NAME } from "@/lib/chain";
import { shortHash } from "@/lib/format";
import {
  addNotes,
  currentRisk,
  dismissToast,
  loanNotes,
  markAllRead,
  openBook,
  riskNote,
  setRisk,
  useNotes,
  type Note,
} from "@/lib/notifications";
import { useWallet } from "@/lib/wallet";
import { borrowerStatus } from "./MarketColumns";
import { TxLink, type Tone } from "./ui";

const DOT: Record<Tone, string> = {
  up: "bg-up",
  down: "bg-down",
  warn: "bg-warn",
  brand: "bg-brand",
  evm: "bg-evm",
  core: "bg-core",
  muted: "bg-muted",
};

const EDGE: Record<Tone, string> = {
  up: "border-l-up",
  down: "border-l-down",
  warn: "border-l-warn",
  brand: "border-l-brand",
  evm: "border-l-evm",
  core: "border-l-core",
  muted: "border-l-muted",
};

/** Watches the snapshot and this page's transactions for anything that touches the connected wallet. */
export function NotificationSync() {
  const { address, tx } = useWallet();
  const snapshot = useCachedSnapshot();

  useEffect(() => openBook(address), [address]);

  useEffect(() => {
    if (address === null || !snapshot) return;
    addNotes(loanNotes(snapshot, address));
    const market = snapshot.markets.find((m) => m.name === "C_afterbell");
    const row = market?.borrowers?.find((b) => b.address.toLowerCase() === address.toLowerCase());
    const status = market && row ? borrowerStatus(row, market.lltv).label : null;
    if (status === currentRisk()) return;
    setRisk(status);
    const note = market && row && status ? riskNote(status, row.ltv, market.lltv, Date.now()) : null;
    if (note) addNotes([note]);
  }, [address, snapshot]);

  // this page's own transactions: the toast at the bottom already shows them live, so these only go in the list
  useEffect(() => {
    if (!tx?.hash || (tx.status !== "done" && tx.status !== "failed")) return;
    const ok = tx.status === "done";
    addNotes(
      [
        {
          id: `tx:${tx.hash}`,
          tone: ok ? "up" : "down",
          title: `${tx.label} ${ok ? "confirmed" : "failed"}`,
          body: ok ? `Your transaction landed on ${EVM_NAME}.` : (tx.error ?? "Your transaction reverted."),
          time: Date.now(),
          tx: tx.hash,
        },
      ],
      { toast: false },
    );
  }, [tx]);

  return null;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 2a4 4 0 0 0-4 4v2.5L2.75 11h10.5L12 8.5V6a4 4 0 0 0-4-4Z" strokeLinejoin="round" />
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" strokeLinecap="round" />
    </svg>
  );
}

const when = (t: number) =>
  new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function Item({ n, fresh }: { n: Note; fresh: boolean }) {
  return (
    <li className={`grid grid-cols-[auto_1fr] gap-2.5 px-3 py-2.5 ${fresh ? "bg-raised" : ""}`}>
      <span className={`mt-1.5 size-1.5 rounded-full ${DOT[n.tone]}`} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-[12px] font-medium">{n.title}</p>
        <p className="text-[11.5px] leading-snug text-muted">{n.body}</p>
        <div className="mt-0.5 flex items-center justify-between">
          <span className="font-mono text-[10px] text-faint" suppressHydrationWarning>
            {when(n.time)}
          </span>
          {n.tx && <TxLink hash={n.tx} />}
        </div>
      </div>
    </li>
  );
}

/** The bell in the top bar: unread count, and the connected wallet's notifications. */
export function NotificationBell() {
  const { address, hasWallet, connect } = useWallet();
  const { notes, read, unread } = useNotes();
  const [open, setOpen] = useState(false);
  // what was unread when the panel opened: still highlighted after opening marks it read
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open) {
      setFresh(new Set(notes.filter((n) => !read.has(n.id)).map((n) => n.id)));
      markAllRead();
    }
    setOpen(!open);
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className={`relative grid size-8 place-items-center rounded-[3px] border ${
          open ? "border-line-strong bg-raised text-foreground" : "border-line-strong text-muted hover:text-foreground"
        }`}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 font-mono text-[9px] font-bold text-black">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-2 w-[min(380px,calc(100vw-1.5rem))] rounded-[3px] border border-line-strong bg-panel font-sans normal-case shadow-2xl shadow-black/60">
          <header className="flex h-9 items-center border-b border-line px-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">Notifications</span>
            {address && <span className="ml-auto font-mono text-[11px] text-faint">{shortHash(address)}</span>}
          </header>
          {address === null ? (
            <div className="flex flex-col gap-3 p-3">
              <p className="text-[12px] text-muted">
                {hasWallet
                  ? "Connect a wallet to get alerts for your loan: near the limit, liquidated, hedged and sold."
                  : `Install MetaMask or Rabby to get alerts for your loan on ${CHAIN_LABEL}.`}
              </p>
              {hasWallet && (
                <button
                  type="button"
                  onClick={() => void connect()}
                  className="h-8 rounded-[3px] bg-brand text-[12px] font-semibold text-black hover:bg-brand/90"
                >
                  Connect wallet
                </button>
              )}
            </div>
          ) : notes.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-faint">
              Nothing yet. Your loan&apos;s alerts show up here: near the limit, liquidated, hedged, sold.
            </p>
          ) : (
            <ol className="flex max-h-[420px] flex-col divide-y divide-line overflow-y-auto">
              {notes.map((n) => (
                <Item key={n.id} n={n} fresh={fresh.has(n.id) || !read.has(n.id)} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** Live events for the connected wallet, top right for a few seconds. */
export function NotificationToasts() {
  const { toasts } = useNotes();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-14 right-3 z-40 flex w-[min(340px,calc(100vw-1.5rem))] flex-col gap-2 sm:right-4">
      {toasts.map((n) => (
        <div
          key={n.id}
          role="status"
          className={`flex items-start gap-2 rounded-[3px] border border-l-2 border-line-strong bg-raised px-3 py-2.5 shadow-2xl shadow-black/60 ${EDGE[n.tone]}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-[12px] font-medium">{n.title}</p>
            <p className="text-[11.5px] leading-snug text-muted">{n.body}</p>
            {n.tx && <TxLink hash={n.tx} className="mt-0.5" />}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(n.id)}
            aria-label="Dismiss"
            className="font-mono text-[14px] leading-none text-faint hover:text-foreground"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
