import { parseAbiItem, type PublicClient } from "viem";

import type { Address, BorrowerState, Hex } from "./types.js";

const borrowEvent = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
);

export interface BorrowerScanOptions {
  readonly morpho: Address;
  readonly marketId: Hex;
  /** Oldest block to backfill to; null → `defaultLookback` blocks under the head at the first poll. */
  readonly fromBlock: bigint | null;
  /** The public HyperEVM RPC refuses eth_getLogs over ~1000 blocks. */
  readonly pageBlocks: bigint;
  /** eth_getLogs calls per poll: new blocks first, then backfill with what's left. */
  readonly maxPagesPerPoll: number;
  readonly defaultLookback?: bigint;
}

/**
 * Morpho can't list a market's borrowers, so the keeper learns them from `Borrow` events on its market. Anyone who
 * borrowed stays watched until their debt reads zero (repaid or liquidated); borrowing again brings them back.
 *
 * Each poll scans the new blocks first, so a fresh loan is seen within a tick even while a long backfill (from the
 * market's creation block, against a rate-limited logs RPC) is still running backwards in the leftover pages.
 */
export class BorrowerScan {
  /** Next block to scan going forward (null before the first poll). */
  private next: bigint | null = null;
  /** Oldest block already scanned going backward. */
  private oldest: bigint | null = null;
  private floor: bigint | null;
  private readonly found = new Map<string, Address>();

  constructor(
    private readonly client: PublicClient,
    private readonly opts: BorrowerScanOptions,
  ) {
    this.floor = opts.fromBlock;
  }

  /** Scans up to `maxPagesPerPoll` pages; returns everyone with a possibly open loan. */
  async poll(head: bigint): Promise<readonly Address[]> {
    const lookback = this.opts.defaultLookback ?? 10_000n;
    const floor = this.floor ?? (head > lookback ? head - lookback : 0n);
    this.floor = floor;
    // the head block itself is the first backfill page's top
    let next = this.next ?? head + 1n;
    let oldest = this.oldest ?? head + 1n;
    if (next > head + 1n) next = head + 1n; // the chain went back (an anvil revert): follow it
    this.next = next;
    this.oldest = oldest;

    let pages = this.opts.maxPagesPerPoll;
    // forward: everything new since the last poll
    while (pages > 0 && next <= head) {
      const last = next + this.opts.pageBlocks - 1n;
      const to = last < head ? last : head;
      await this.scan(next, to);
      next = to + 1n;
      this.next = next;
      pages -= 1;
    }
    // backward: older blocks, down to the floor
    while (pages > 0 && oldest > floor) {
      const from = oldest - this.opts.pageBlocks > floor ? oldest - this.opts.pageBlocks : floor;
      await this.scan(from, oldest - 1n);
      oldest = from;
      this.oldest = oldest;
      pages -= 1;
    }
    return [...this.found.values()];
  }

  /** Forget borrowers whose debt is gone. Call with the positions this tick read. */
  prune(borrowers: readonly BorrowerState[]): void {
    for (const b of borrowers) if (b.borrowAssets === 0n) this.found.delete(b.address.toLowerCase());
  }

  /** Blocks still to scan, either way, before the list is complete (0 once caught up). */
  behind(head: bigint): bigint {
    if (this.next === null || this.oldest === null || this.floor === null) return 0n;
    const forward = this.next > head ? 0n : head - this.next + 1n;
    return forward + (this.oldest > this.floor ? this.oldest - this.floor : 0n);
  }

  private async scan(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const logs = await this.client.getLogs({
      address: this.opts.morpho,
      event: borrowEvent,
      args: { id: this.opts.marketId },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const who = log.args.onBehalf;
      if (who !== undefined) this.found.set(who.toLowerCase(), who);
    }
  }
}
