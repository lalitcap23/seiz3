"use client";

import { useSyncExternalStore } from "react";
import type { Snapshot } from "@seiz3/shared";
import type { Tone } from "@/components/ui";
import { nvdax, usd } from "./format";

/** Something that happened to the connected wallet's loan or transactions. */
export interface Note {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  time: number; // ms
  tx?: string; // Base Sepolia tx hash
}

/** One wallet's notifications, kept in this browser. */
interface Book {
  notes: Note[];
  read: string[];
  /** The loan's status when last seen, so a reload doesn't repeat "at the limit". */
  risk: string | null;
}

export interface Notes {
  owner: string | null;
  notes: Note[];
  read: ReadonlySet<string>;
  unread: number;
  /** Live events, shown in the corner for a few seconds. */
  toasts: Note[];
}

/** Events newer than this toast as they arrive; older ones (a revisit, history still loading) only land in the list. */
const TOAST_IF_NEWER_MS = 120_000;
const TOAST_MS = 8_000;
/**
 * Transactions and risk alerts kept, newest first. The loan's own history (op:…) is never dropped: the snapshot
 * re-derives it every second, so a dropped one would come back as new.
 */
const OTHERS_KEPT = 30;

const EMPTY: Book = { notes: [], read: [], risk: null };
const SERVER: Notes = { owner: null, notes: [], read: new Set(), unread: 0, toasts: [] };

let owner: string | null = null;
let book: Book = EMPTY;
let toasts: Note[] = [];
let state: Notes = SERVER;
const watchers = new Set<() => void>();

const storageKey = (address: string) => `seiz3:notes:${address}`;

function changed(persist = true) {
  if (persist && owner !== null) {
    try {
      localStorage.setItem(storageKey(owner), JSON.stringify(book));
    } catch {
      // private window or storage full: the list still works for this visit
    }
  }
  const read = new Set(book.read);
  state = { owner, notes: book.notes, read, unread: book.notes.filter((n) => !read.has(n.id)).length, toasts };
  for (const w of watchers) w();
}

/** Switches to this wallet's notifications (none while no wallet is connected). */
export function openBook(address: string | null) {
  const next = address?.toLowerCase() ?? null;
  if (next === owner) return;
  owner = next;
  book = EMPTY;
  if (next !== null) {
    try {
      book = { ...EMPTY, ...(JSON.parse(localStorage.getItem(storageKey(next)) ?? "{}") as Partial<Book>) };
    } catch {
      book = EMPTY;
    }
  }
  toasts = [];
  changed(false);
}

/** Adds the notes not seen before; recent ones also toast unless `toast` is false. */
export function addNotes(incoming: Note[], { toast = true } = {}) {
  const known = new Set(book.notes.map((n) => n.id));
  const fresh = incoming.filter((n) => !known.has(n.id));
  if (owner === null || fresh.length === 0) return;
  const all = [...fresh, ...book.notes].sort((a, b) => b.time - a.time);
  const others = new Set(all.filter((n) => !n.id.startsWith("op:")).slice(0, OTHERS_KEPT));
  const notes = all.filter((n) => n.id.startsWith("op:") || others.has(n));
  const kept = new Set(notes.map((n) => n.id));
  book = { ...book, notes, read: book.read.filter((id) => kept.has(id)) };
  if (toast) {
    const now = Date.now();
    const live = fresh.filter((n) => now - n.time < TOAST_IF_NEWER_MS).sort((a, b) => b.time - a.time);
    toasts = [...live, ...toasts].slice(0, 4);
    for (const n of live) setTimeout(() => dismissToast(n.id), TOAST_MS);
  }
  changed();
}

export const currentRisk = () => book.risk;

export function setRisk(risk: string | null) {
  if (owner === null || book.risk === risk) return;
  book = { ...book, risk };
  changed();
}

export function markAllRead() {
  if (state.unread === 0) return;
  book = { ...book, read: book.notes.map((n) => n.id) };
  changed();
}

export function dismissToast(id: string) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  changed(false);
}

export function useNotes(): Notes {
  return useSyncExternalStore(
    (w) => (watchers.add(w), () => void watchers.delete(w)),
    () => state,
    () => SERVER,
  );
}

/**
 * Your loan's story from the snapshot: each liquidation of it, the hedge that covered it, and each unwind that sold
 * its stock. Ids are stable, so deriving this every second adds only what's new.
 */
export function loanNotes(snapshot: Snapshot, address: string): Note[] {
  const me = address.toLowerCase();
  const ops = snapshot.operations ?? [];
  const byId = new Map(ops.map((o) => [o.id, o]));
  const notes: Note[] = [];
  for (const op of ops) {
    if (op.kind !== "liquidation" || op.borrower?.toLowerCase() !== me) continue;
    notes.push({
      id: `op:${op.id}`,
      tone: "down",
      title: "Your loan was liquidated",
      body: `${op.id}: the Seiz3 vault bought ${nvdax(op.nvdax).toFixed(4)} NVDAx of your collateral, repaying ${usd(op.usdc, 2)} of your debt.`,
      time: op.timestamp,
      tx: op.txHash,
    });
    if (op.confirmed) {
      const shorted = op.orders.reduce((sum, o) => sum + o.filled, 0);
      notes.push({
        id: `op:${op.id}:hedged`,
        tone: "up",
        title: "Your liquidation is hedged",
        body: `${op.id}: the vault shorted ${shorted.toFixed(3)} NVDA on HyperCore against your stock, and syncHedge confirmed it.`,
        time: op.confirmed.timestamp,
        tx: op.confirmed.txHash,
      });
    }
    for (const lot of op.lots) {
      const unwind = byId.get(lot.opId);
      if (!unwind) continue;
      notes.push({
        id: `op:${op.id}:${lot.opId}`,
        tone: "core",
        title: "Your seized stock was sold",
        body: `${lot.opId} sold ${nvdax(lot.nvdax).toFixed(4)} NVDAx of ${op.id} into Uniswap v4.`,
        time: unwind.timestamp,
        tx: unwind.txHash,
      });
    }
  }
  return notes;
}

/** An alert for a loan that just reached the limit ("limit") or crossed it ("liq"); null for any other status. */
export function riskNote(status: string, ltv: number, lltv: number, now: number): Note | null {
  const at = `${(ltv * 100).toFixed(2)}%`;
  const limit = `${(lltv * 100).toFixed(0)}%`;
  if (status === "limit") {
    return {
      id: `risk:limit:${now}`,
      tone: "warn",
      title: "Your loan is at the liquidation limit",
      body: `LTV ${at} of the ${limit} LLTV. Interest will tip it over, and the keeper liquidates it through the vault.`,
      time: now,
    };
  }
  if (status === "liq") {
    return {
      id: `risk:liq:${now}`,
      tone: "down",
      title: "Your loan is liquidatable",
      body: `LTV ${at} is past the ${limit} LLTV: the keeper liquidates it through the Seiz3 vault.`,
      time: now,
    };
  }
  return null;
}
