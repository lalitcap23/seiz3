import type { ActivityEvent, HedgeOrder, Operation } from "@seiz3/shared";

/** One of the vault's fills on HyperCore, as Hyperliquid's `userFills` returns it. */
export interface CoreFill {
  cloid?: string | null;
  sz: string;
  px: string;
  hash: string;
  time: number;
}

/** Below this much NVDAx a lot counts as used up (the Core size step is 1e15 at szDecimals 3). */
const DUST = 10n ** 12n;

const round = (x: number, digits: number) => Number(x.toFixed(digits));

/**
 * Liquidations and unwinds, numbered and linked. Each LiquidationTaken or Unwound transaction starts an operation (an
 * Unwound with the hook's InventoryFill beside it is a buyer filled from the vault, otherwise a keeper push); the
 * vault keeps one hedge in flight at a time, so every HedgeSent and HedgeConfirmed after it, until it's confirmed,
 * belongs to it (retries included). Unwinds sell the vault's stock first in, first out, so each one says whose stock
 * it sold, and each liquidation how much of it is still held. Stock already there before the first scanned block is
 * LIQ-0. Returns the operations oldest first and, for the activity feed, which one each event belongs to.
 */
export function buildOperations(
  events: readonly ActivityEvent[],
  fills: readonly CoreFill[],
  inventoryNow: bigint,
): { operations: Operation[]; opOf: Map<ActivityEvent, string> } {
  const fillsByCloid = new Map<string, CoreFill[]>();
  for (const f of fills) {
    if (!f.cloid) continue;
    const k = f.cloid.toLowerCase();
    fillsByCloid.set(k, [...(fillsByCloid.get(k) ?? []), f]);
  }
  const order = (e: ActivityEvent): HedgeOrder => {
    const fs = (e.cloid ? fillsByCloid.get(e.cloid.toLowerCase()) : undefined) ?? [];
    // rounded off float noise: fills of 0.806 + 0.049 would sum to 0.8550000000000001
    const filled = round(fs.reduce((s, f) => s + Number(f.sz), 0), 8);
    return {
      txHash: e.txHash,
      cloid: e.cloid ?? "",
      delta: String(e.args.delta),
      tries: Number(e.args.tries),
      limitPx: Number(e.args.limitPx) / 1e8, // CoreWriter wire price: human × 1e8
      filled,
      avgPx: filled === 0 ? null : round(fs.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0) / filled, 6),
      fills: fs.map((f) => ({ sz: f.sz, px: f.px, hash: f.hash, time: f.time })),
    };
  };

  const operations: Operation[] = [];
  const opOf = new Map<ActivityEvent, string>();
  let current: Operation | null = null;
  let liq = 0;
  let unw = 0;

  for (let i = 0; i < events.length; ) {
    const tx = events[i]!.txHash;
    const group: ActivityEvent[] = [];
    while (i < events.length && events[i]!.txHash === tx) group.push(events[i++]!);

    const start = group.find((e) => e.type === "LiquidationTaken" || e.type === "Unwound");
    if (start) {
      const isLiq = start.type === "LiquidationTaken";
      current = {
        id: isLiq ? `LIQ-${++liq}` : `UNW-${++unw}`,
        kind: isLiq ? "liquidation" : "unwind",
        txHash: tx,
        blockNumber: start.blockNumber,
        timestamp: start.timestamp,
        borrower: isLiq ? String(start.args.borrower) : null,
        market: isLiq ? "C_seiz3" : null, // the vault only liquidates its allow-listed market
        nvdax: String(isLiq ? start.args.seized : start.args.chunk),
        usdc: String(isLiq ? start.args.repaid : start.args.usdcOut),
        orders: [],
        confirmed: null,
        lots: [],
        held: "0",
        // the hook's InventoryFill rides in the same transaction as the vault's Unwound
        soldTo: isLiq ? null : group.some((e) => e.type === "InventoryFill") ? "buyer" : "pool",
      };
      operations.push(current);
    }
    for (const e of group) {
      if (current === null) continue; // a confirmation of something from before the feed
      if (e.type === "HedgeSent" && current.confirmed === null) current.orders.push(order(e));
      if (e.type === "HedgeConfirmed" && current.confirmed === null) {
        current.confirmed = { txHash: e.txHash, timestamp: e.timestamp, actual: String(e.args.actual) };
      }
      opOf.set(e, current.id);
    }
  }

  // first in, first out
  const seized = operations.filter((o) => o.kind === "liquidation").reduce((s, o) => s + BigInt(o.nvdax), 0n);
  const sold = operations.filter((o) => o.kind === "unwind").reduce((s, o) => s + BigInt(o.nvdax), 0n);
  const before = inventoryNow - seized + sold;
  const lots: { op: Operation; left: bigint }[] = [];
  if (before > DUST) {
    const first = events[0];
    const zero: Operation = {
      id: "LIQ-0",
      kind: "liquidation",
      txHash: "",
      blockNumber: first ? first.blockNumber : "0",
      timestamp: first ? first.timestamp : 0,
      borrower: null,
      market: "C_seiz3",
      nvdax: before.toString(),
      usdc: "0",
      orders: [],
      confirmed: null,
      lots: [],
      held: "0",
      soldTo: null,
    };
    operations.unshift(zero);
    lots.push({ op: zero, left: before });
  }
  for (const op of operations) {
    if (op.id === "LIQ-0") continue;
    if (op.kind === "liquidation") {
      lots.push({ op, left: BigInt(op.nvdax) });
      continue;
    }
    let need = BigInt(op.nvdax);
    while (need > 0n && lots.length > 0) {
      const lot = lots[0]!;
      const take = lot.left < need ? lot.left : need;
      lot.left -= take;
      need -= take;
      op.lots.push({ opId: lot.op.id, nvdax: take.toString() });
      lot.op.lots.push({ opId: op.id, nvdax: take.toString() });
      if (lot.left <= DUST) lots.shift();
    }
  }
  for (const { op, left } of lots) op.held = (left > DUST ? left : 0n).toString();
  return { operations, opOf };
}
