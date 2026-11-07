"use client";

import { useState } from "react";
import type { Operation } from "@seiz3/shared";
import type { Me } from "@/lib/me";

const WAD = 10n ** 18n;
/** Max leaves this much interest (in seconds of it) under the limit: enough for the tx to land, then it tips over. */
const TIP_OVER_SEC = 15n;
/** Debt Morpho leaves behind after a liquidation: a few wei of rounding (under a cent). Less than this isn't a loan. */
export const DUST = 10_000n;

/** What Max leaves under the limit: ~15 s of interest, at least the rounding Morpho adds. */
function margin(me: Me): bigint {
  const interest = (me.position.maxDebt * me.market.ratePerSec * TIP_OVER_SEC) / WAD;
  return (interest > 3n ? interest : 3n) + 1n;
}

/** USDC Max may borrow: up to the LLTV, minus the margin, and no more than the market has. */
export function maxBorrow(me: Me): bigint {
  const out = me.position.maxDebt - me.position.debt - margin(me);
  if (out <= 0n) return 0n;
  return out < me.market.liquidity ? out : me.market.liquidity;
}

/** Seconds of interest until a Max borrow crosses the limit: the margin over the interest a second. */
export function tipOverSec(me: Me): number | null {
  const perSec = (Number(me.position.maxDebt) * Number(me.market.ratePerSec)) / 1e18;
  return perSec > 0 ? Math.ceil(Number(margin(me)) / perSec) : null;
}

/** Seconds until the open loan's interest crosses the limit at today's price (null: no loan, or no interest). */
export function secondsLeft(me: Me): number | null {
  const p = me.position;
  if (p.debt === 0n || p.debt > p.maxDebt) return null;
  const perSec = (Number(p.debt) * Number(me.market.ratePerSec)) / 1e18;
  return perSec > 0 ? Math.floor(Number(p.maxDebt - p.debt) / perSec) : null;
}

/** This wallet's liquidations, oldest first. */
export function myLiquidations(operations: Operation[], address: string | null): Operation[] {
  if (address === null) return [];
  const a = address.toLowerCase();
  return operations.filter((o) => o.kind === "liquidation" && o.borrower?.toLowerCase() === a);
}

/** The borrower's path through the demo, in order. `done` is past the last one. */
export const STEPS = [
  { key: "connect", label: "Connect" },
  { key: "faucet", label: "Get tokens" },
  { key: "deposit", label: "Deposit" },
  { key: "borrow", label: "Borrow" },
  { key: "liquidate", label: "Liquidation" },
  { key: "unwind", label: "Unwind" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"] | "done" | "loading";

/** The other parts a tester can play, beside the borrower. */
export type Role = "lender" | "vault" | "buyer";

const ACK_KEY = "seiz3.try.ack";

function loadAcks(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(ACK_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export interface Journey {
  step: StepKey;
  /** This wallet's newest liquidation, the one the unwind and done steps are about. */
  latest: Operation | null;
  /** The loan just closed and its liquidation isn't in the feed yet. */
  closing: boolean;
  /** Moves past the newest liquidation (done, or still unwinding) to start another round. */
  nextRound: () => void;
  /** The loan closed for another reason (repaid): stop waiting for its liquidation. */
  forgetLoan: () => void;
}

/**
 * Where this wallet is in the demo, from its balances and position (`me`) and the API's operations. Only one step is
 * current, so the page can show just that one action.
 */
export function useJourney({
  hasWallet,
  address,
  onChain,
  me,
  operations,
}: {
  hasWallet: boolean;
  address: string | null;
  onChain: boolean;
  me: Me | undefined;
  operations: Operation[];
}): Journey {
  const mine = myLiquidations(operations, address);
  const latest = mine.at(-1) ?? null;
  const open = !!me && me.position.debt >= DUST;

  // the open loan as last seen, with how many liquidations this wallet had then: once the loan closes, wait until the
  // feed shows one more, so the page doesn't flash back to "Borrow" in the seconds before the liquidation is scanned.
  // `off` once the person repaid it themselves; a new loan (other borrow shares) arms it again.
  const [watch, setWatch] = useState<{ address: string; count: number; shares: bigint; off: boolean } | null>(null);
  if (
    open &&
    address !== null &&
    !(watch?.address === address && watch.count === mine.length && watch.shares === me.position.borrowShares)
  ) {
    setWatch({ address, count: mine.length, shares: me.position.borrowShares, off: false });
  }
  const closing = !open && watch !== null && !watch.off && watch.address === address && mine.length <= watch.count;

  // the liquidation this wallet has moved on from, per address (survives a reload)
  const [acks, setAcks] = useState(loadAcks);
  const acked = latest !== null && address !== null && acks[address.toLowerCase()] === latest.id;

  function nextRound() {
    if (latest === null || address === null) return;
    const next = { ...acks, [address.toLowerCase()]: latest.id };
    setAcks(next);
    try {
      window.localStorage.setItem(ACK_KEY, JSON.stringify(next));
    } catch {
      // private window: it lasts until reload
    }
  }

  let step: StepKey;
  if (!hasWallet || address === null || !onChain) step = "connect";
  else if (!me) step = "loading";
  else if (open || closing) step = "liquidate";
  else if (latest !== null && !acked) step = BigInt(latest.held) > 0n ? "unwind" : "done";
  else if (me.position.collateral > 0n) step = "borrow";
  else if (me.nvdax > 0n && me.hype > 0n) step = "deposit";
  else step = "faucet";

  return { step, latest, closing, nextRound, forgetLoan: () => setWatch((w) => w && { ...w, off: true }) };
}
