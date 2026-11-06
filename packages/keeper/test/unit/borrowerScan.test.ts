import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { BorrowerScan } from "../../src/borrowerScan.js";
import type { Address, Hex } from "../../src/types.js";
import { BORROWER_A, BORROWER_B } from "./fixtures.js";

const MORPHO = "0x00000000000000000000000000000000000000Aa" as Address;
const MARKET = `0x${"11".repeat(32)}` as Hex;

/** Borrow events at fixed blocks; records every getLogs range it was asked for. */
function fakeClient(events: { block: bigint; onBehalf: Address }[]) {
  const ranges: [bigint, bigint][] = [];
  const client = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return events
        .filter((e) => e.block >= fromBlock && e.block <= toBlock)
        .map((e) => ({ args: { onBehalf: e.onBehalf } }));
    },
  } as unknown as PublicClient;
  return { client, ranges };
}

const scanner = (client: PublicClient, fromBlock: bigint | null = 100n) =>
  new BorrowerScan(client, { morpho: MORPHO, marketId: MARKET, fromBlock, pageBlocks: 500n, maxPagesPerPoll: 2 });

describe("borrower scan", () => {
  it("backfills from the head down to the start block, two pages a poll", async () => {
    const { client, ranges } = fakeClient([
      { block: 150n, onBehalf: BORROWER_A },
      { block: 1_900n, onBehalf: BORROWER_B },
    ]);
    const scan = scanner(client);

    expect(await scan.poll(2_000n)).toEqual([BORROWER_B]);
    expect(ranges).toEqual([
      [1_501n, 2_000n],
      [1_001n, 1_500n],
    ]);
    expect(scan.behind(2_000n)).toBe(901n);

    expect(await scan.poll(2_000n)).toEqual([BORROWER_B, BORROWER_A]);
    expect(ranges.at(-1)).toEqual([100n, 500n]);
    expect(scan.behind(2_000n)).toBe(0n);
    await scan.poll(2_000n);
    expect(ranges).toHaveLength(4); // caught up: nothing more to ask for
  });

  it("sees a new loan on the next poll even while the backfill is far from done", async () => {
    const events: { block: bigint; onBehalf: Address }[] = [];
    const { client, ranges } = fakeClient(events);
    const scan = scanner(client, 0n);
    await scan.poll(100_000n);

    events.push({ block: 100_002n, onBehalf: BORROWER_A });
    expect(await scan.poll(100_003n)).toEqual([BORROWER_A]);
    expect(ranges.at(-2)).toEqual([100_001n, 100_003n]); // new blocks first, then one backfill page
  });

  it("drops repaid borrowers until they borrow again", async () => {
    const events = [{ block: 150n, onBehalf: BORROWER_A }];
    const { client } = fakeClient(events);
    const scan = scanner(client);
    await scan.poll(200n);

    scan.prune([{ address: BORROWER_A, collateral: 0n, borrowAssets: 0n }]);
    expect(await scan.poll(200n)).toEqual([]);

    events.push({ block: 250n, onBehalf: BORROWER_A });
    expect(await scan.poll(300n)).toEqual([BORROWER_A]);
  });

  it("starts 10k blocks back without a start block, and follows a rewound chain", async () => {
    const { client, ranges } = fakeClient([]);
    const scan = scanner(client, null);
    await scan.poll(20_000n);
    await scan.poll(20_000n);
    expect(scan.behind(20_000n)).toBe(8_001n); // blocks 10,000…18,000 left

    // head went back to 19,000: wait for block 19,001 instead of skipping
    const asked = ranges.length;
    while (scan.behind(20_000n) > 0n) await scan.poll(20_000n);
    const caughtUp = ranges.length;
    expect(caughtUp).toBeGreaterThan(asked);
    await scan.poll(19_000n);
    expect(ranges).toHaveLength(caughtUp);
    await scan.poll(19_001n);
    expect(ranges.at(-1)).toEqual([19_001n, 19_001n]);
  });
});
