import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseAbiItem, toHex, type AbiEvent, type Address, type PublicClient } from "viem";
import { afterbellVaultAbi, naiveLiquidatorAbi } from "@afterbell/shared/abis";
import type { ActivityEvent, MarketLiquidation, MarketName } from "@afterbell/shared";
import { MARKETS } from "./chain.js";
import type { DeploymentFile } from "@afterbell/shared/node";

const ACTIVITY: readonly string[] = [
  "LiquidationTaken",
  "HedgeSent",
  "HedgeConfirmed",
  "HedgeStuck",
  "Unwound",
  "MarginMoved",
] satisfies ActivityEvent["type"][];
const ACTIVITY_KEPT = 50;

const morphoLiquidate = parseAbiItem(
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
);
const morphoBorrow = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
);
const vaultEvents = afterbellVaultAbi.filter(
  (item): item is Extract<(typeof afterbellVaultAbi)[number], { type: "event" }> =>
    item.type === "event" && ACTIVITY.includes(item.name),
);
const shortfall = naiveLiquidatorAbi.find(
  (item): item is Extract<(typeof naiveLiquidatorAbi)[number], { type: "event"; name: "Shortfall" }> =>
    item.type === "event" && item.name === "Shortfall",
);

/** Alchemy's free tier answers eth_getLogs for 10 blocks at a time, and it's the RPC whose head the snapshot reads. */
const TAIL_PAGE = 10n;
/** Pages per poll while the tail catches up (after a hiccup, or from the cache on a restart). */
const TAIL_PAGES_PER_POLL = 5;
/** A restart this far behind the cache resumes on the tail; further, the gap goes to the backfill. */
const TAIL_CATCHUP = TAIL_PAGE * 10n;
/** Blocks the tail reads again: a load-balanced RPC can serve a block before its logs are indexed, and answer []. */
const OVERLAP = 3n;
const DEFAULT_LOOKBACK = 10_000n;
const BACKOFF_MAX_MS = 30_000;
const PERSIST_EVERY_MS = 10_000;

const plain = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] ?? String(err) : String(err));
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** One log, decoded and JSON-safe: the cache stores these, and the feed is rebuilt from them. */
interface Entry {
  key: string; // txHash:logIndex, so reading a block twice changes nothing
  block: string;
  index: number;
  txHash: `0x${string}`;
  time: number; // ms
  address: string; // lowercase
  name: string;
  args: Record<string, unknown>;
  cloid?: string;
}

interface Cache {
  vault: string;
  from: string;
  /** Every block from `from` to here is in `entries`. */
  scannedTo: string;
  entries: Entry[];
}

export interface LogScannerOptions {
  /** eth_getLogs client for the history; the tail stays on the main client. */
  logsClient?: PublicClient;
  /** Blocks per backfill call (thirdweb serves 1000, the public HyperEVM RPC 500). */
  backfillPage?: bigint;
  /** Gap between backfill calls: a keyless logs RPC rate-limits by the second. */
  backfillGapMs?: number;
  /** Where the scanned history survives a restart; unset on anvil, whose reverts would make it lie. */
  cacheFile?: string;
  /** Anvil: the chain can go back (the replay's reset). HyperEVM never does, so a lower head is a lagging RPC node. */
  chainRewinds?: boolean;
}

/** How current the feed is, for the snapshot: the dashboard says so instead of quietly showing old activity. */
export interface FeedStatus {
  behind: number; // blocks between the chain's head and the newest scanned block
  historyLeft: number; // blocks of history still to load
  error: string | null;
}

/**
 * The activity feed (vault events) and each market's bad debt: Morpho's realised `badDebtAssets`, plus, for market A,
 * the shortfall NaiveLiquidator covers so its transaction succeeds ("bad debt the lenders would have eaten").
 *
 * Two readers. The tail follows the head on the main RPC, in the same poll as the snapshot's multicall, so a new
 * unwind shows up with the state it changed. The backfill loads the history behind it on the logs RPC, at its own
 * pace with backoff, and never holds up the tail. Every log is keyed, so re-reading a block is harmless.
 */
export class LogScanner {
  activity: ActivityEvent[] = [];
  /** Every vault event since the start block: operations (LIQ-n / UNW-n) are numbered and linked from it. */
  all: ActivityEvent[] = [];
  /** Morpho liquidations per market (opId is filled in by the collector). */
  readonly liquidations = new Map<MarketName, MarketLiquidation[]>(MARKETS.map((m) => [m, []]));
  /** Everyone who borrowed on one of the three markets. */
  readonly borrowers = new Set<Address>();
  readonly badDebt = new Map<MarketName, bigint>(MARKETS.map((m) => [m, 0n]));

  private entries = new Map<string, Entry>();
  private dirty = false;
  private floor = 0n;
  /** Tail: [tailFrom, tailNext) is scanned. Backfill: [floor, backfillNext) is scanned, up to tailFrom. */
  private tailFrom = 0n;
  private tailNext: bigint | null = null;
  private backfillNext = 0n;
  private tailError: string | null = null;
  private backfillError: string | null = null;
  private head = 0n;
  /** Bumped on a reset or stop: a backfill still awaiting from before drops what it read. */
  private epoch = 0;
  private persistedAt = 0;
  private readonly times = new Map<bigint, number>();
  private readonly marketById: Map<string, MarketName>;
  private readonly addresses: Address[];
  private readonly events: AbiEvent[];
  private readonly logsClient: PublicClient;

  constructor(
    private readonly client: PublicClient,
    private readonly dep: DeploymentFile,
    private readonly fromBlock: bigint | null,
    private readonly opts: LogScannerOptions = {},
  ) {
    this.logsClient = opts.logsClient ?? client;
    this.marketById = new Map(MARKETS.map((m) => [dep.markets[m].id.toLowerCase(), m]));
    this.addresses = [dep.vault, dep.morpho, ...(dep.naiveLiquidator ? [dep.naiveLiquidator] : [])];
    this.events = [...vaultEvents, morphoLiquidate, morphoBorrow, ...(shortfall ? [shortfall] : [])] as AbiEvent[];
  }

  /** Reads the new blocks up to `head` (the snapshot's block). Throws when neither RPC answers; the next poll retries. */
  async follow(head: bigint): Promise<void> {
    this.head = head;
    // the chain went back; elsewhere the tail just waits below for the lagging node to catch up
    if (this.opts.chainRewinds && this.tailNext !== null && this.tailNext > head + 1n) this.reset();
    if (this.tailNext === null) this.begin(head);
    try {
      for (let page = 0; page < TAIL_PAGES_PER_POLL && this.tailNext! <= head; page++) {
        const from = max(this.tailNext! - OVERLAP, this.tailFrom);
        const to = min(from + TAIL_PAGE - 1n, head);
        const epoch = this.epoch;
        const read = await this.read(this.client, from, to).catch((err: unknown) =>
          // a second opinion before giving up on this poll
          this.logsClient === this.client ? Promise.reject(err) : this.read(this.logsClient, from, to),
        );
        if (epoch !== this.epoch) return;
        this.commit(read);
        this.tailNext = to + 1n;
      }
      this.tailError = null;
    } catch (err) {
      this.tailError = errorText(err);
      throw err;
    } finally {
      this.rebuild();
      this.persist(false);
    }
  }

  status(): FeedStatus {
    const scanned = this.tailNext === null ? this.floor : this.tailNext - 1n;
    return {
      behind: Number(this.head > scanned ? this.head - scanned : 0n),
      historyLeft: Number(this.tailFrom > this.backfillNext ? this.tailFrom - this.backfillNext : 0n),
      error: this.tailError ?? this.backfillError,
    };
  }

  /** Stops the backfill (the collector swaps scanners after a redeploy) and saves what's scanned. */
  stop(): void {
    this.persist(true);
    this.epoch++;
  }

  /** First poll: resume from the cache when it's this vault's, then start the tail at the head and backfill the rest. */
  private begin(head: bigint): void {
    this.floor = this.fromBlock ?? (head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n);
    let resume = this.floor;
    const cache = this.load();
    if (cache !== null) {
      for (const e of cache.entries) if (BigInt(e.block) >= this.floor) this.entries.set(e.key, e);
      resume = BigInt(cache.scannedTo) + 1n;
      this.dirty = true;
      console.log(`[api] feed: ${cache.entries.length} logs from the cache, scanned to block ${cache.scannedTo}`);
    }
    // a short gap is quicker on the tail than through the logs RPC
    this.tailFrom = head + 1n - resume <= TAIL_CATCHUP ? resume : head;
    this.tailNext = this.tailFrom;
    this.backfillNext = resume;
    if (this.backfillNext < this.tailFrom) void this.backfill(this.epoch);
  }

  /** Oldest first, up to where the tail started; backs off on the logs RPC's rate limit instead of hammering it. */
  private async backfill(epoch: number): Promise<void> {
    const page = this.opts.backfillPage ?? 500n;
    const gap = this.opts.backfillGapMs ?? 0;
    let wait = 0;
    while (epoch === this.epoch && this.backfillNext < this.tailFrom) {
      if (wait > 0) await sleep(wait);
      const from = this.backfillNext;
      const to = min(from + page - 1n, this.tailFrom - 1n);
      try {
        const read = await this.read(this.logsClient, from, to);
        if (epoch !== this.epoch) return;
        this.commit(read);
        this.backfillNext = to + 1n;
        if (this.backfillError !== null) console.log("[api] feed backfill recovered");
        this.backfillError = null;
        wait = gap;
      } catch (err) {
        if (epoch !== this.epoch) return;
        const message = errorText(err);
        if (message !== this.backfillError) console.error(`[api] feed backfill failed, backing off: ${message}`);
        this.backfillError = message;
        wait = Math.min(Math.max(wait * 2, 1_000), BACKOFF_MAX_MS);
      }
    }
    if (epoch !== this.epoch) return;
    console.log(`[api] feed history loaded from block ${this.floor}`);
    this.persist(true);
  }

  /** Fetches and decodes one range, timestamps included; nothing is kept until `commit`, so a failure leaves no half page. */
  private async read(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<Entry[]> {
    const logs = (await client.getLogs({
      address: this.addresses,
      events: this.events,
      fromBlock,
      toBlock,
    })) as unknown as DecodedLog[];
    const out: Entry[] = [];
    for (const log of logs) {
      const address = log.address.toLowerCase();
      // Morpho is shared: only the three markets' logs are worth keeping
      if (address === this.dep.morpho.toLowerCase() && !this.marketById.has(String(log.args.id).toLowerCase())) continue;
      const cloid = log.args.cloid;
      out.push({
        key: `${log.transactionHash}:${log.logIndex}`,
        block: log.blockNumber.toString(),
        index: log.logIndex,
        txHash: log.transactionHash,
        time: await this.timeOf(log),
        address,
        name: log.eventName,
        args: plain(log.args),
        ...(typeof cloid === "bigint" ? { cloid: toHex(cloid, { size: 16 }) } : {}),
      });
    }
    return out;
  }

  private commit(entries: Entry[]): void {
    for (const e of entries) {
      if (this.entries.has(e.key)) continue;
      this.entries.set(e.key, e);
      this.dirty = true;
    }
  }

  /** The feed, liquidations, bad debt and borrowers from every log, in chain order, whichever reader found it. */
  private rebuild(): void {
    if (!this.dirty) return;
    const sorted = [...this.entries.values()].sort((a, b) => {
      const d = BigInt(a.block) - BigInt(b.block);
      return d !== 0n ? (d < 0n ? -1 : 1) : a.index - b.index;
    });
    this.all = [];
    this.borrowers.clear();
    for (const m of MARKETS) this.liquidations.set(m, []);
    for (const m of MARKETS) this.badDebt.set(m, 0n);
    const morpho = this.dep.morpho.toLowerCase();
    const naive = this.dep.naiveLiquidator?.toLowerCase();
    const vault = this.dep.vault.toLowerCase();
    for (const e of sorted) {
      const a = e.args;
      if (e.address === morpho) {
        const market = this.marketById.get(String(a.id).toLowerCase());
        if (market === undefined) continue;
        if (e.name === "Borrow") {
          this.borrowers.add(a.onBehalf as Address);
          continue;
        }
        this.addBadDebt(market, BigInt(String(a.badDebtAssets)));
        const caller = String(a.caller).toLowerCase();
        this.liquidations.get(market)?.push({
          txHash: e.txHash,
          blockNumber: e.block,
          timestamp: e.time,
          borrower: String(a.borrower),
          repaid: String(a.repaidAssets),
          seized: String(a.seizedAssets),
          badDebt: String(a.badDebtAssets),
          by: caller === vault ? "vault" : caller === naive ? "naive" : "other",
          opId: null,
        });
        continue;
      }
      if (e.address === naive) {
        this.addBadDebt("A_naive", BigInt(String(a.shortfall)));
        continue;
      }
      this.all.push({
        type: e.name as ActivityEvent["type"],
        txHash: e.txHash,
        blockNumber: e.block,
        timestamp: e.time,
        ...(e.cloid ? { cloid: e.cloid } : {}),
        args: a,
      });
    }
    this.activity = this.all.slice(-ACTIVITY_KEPT);
    this.dirty = false;
  }

  private reset(): void {
    this.epoch++;
    this.entries.clear();
    this.times.clear();
    this.tailNext = null;
    this.tailError = null;
    this.backfillError = null;
    this.dirty = true;
  }

  private addBadDebt(market: MarketName, amount: bigint): void {
    this.badDebt.set(market, (this.badDebt.get(market) ?? 0n) + amount);
  }

  /** HyperEVM's logs carry their block's timestamp; any RPC that leaves it out costs one getBlock per block. */
  private async timeOf(log: DecodedLog): Promise<number> {
    if (log.blockTimestamp !== undefined && log.blockTimestamp !== null) return Number(log.blockTimestamp) * 1000;
    let t = this.times.get(log.blockNumber);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber: log.blockNumber })).timestamp) * 1000;
      this.times.set(log.blockNumber, t);
    }
    return t;
  }

  /** Everything from the floor up to the first block not yet scanned, written whole (tmp + rename). */
  private persist(force: boolean): void {
    const file = this.opts.cacheFile;
    if (file === undefined || this.tailNext === null) return;
    if (!force && Date.now() - this.persistedAt < PERSIST_EVERY_MS) return;
    this.persistedAt = Date.now();
    const scannedTo = (this.backfillNext < this.tailFrom ? this.backfillNext : this.tailNext) - 1n;
    if (scannedTo < this.floor) return;
    const cache: Cache = {
      vault: this.dep.vault.toLowerCase(),
      from: this.floor.toString(),
      scannedTo: scannedTo.toString(),
      entries: [...this.entries.values()].filter((e) => BigInt(e.block) <= scannedTo),
    };
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(cache));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(`[api] feed cache not saved: ${errorText(err)}`);
    }
  }

  /** The cache when it's this vault's and reaches back to the floor; anything else is ignored and rebuilt. */
  private load(): Cache | null {
    const file = this.opts.cacheFile;
    if (file === undefined || !existsSync(file)) return null;
    try {
      const cache = JSON.parse(readFileSync(file, "utf8")) as Cache;
      if (cache.vault !== this.dep.vault.toLowerCase() || BigInt(cache.from) > this.floor) return null;
      if (BigInt(cache.scannedTo) < this.floor || !Array.isArray(cache.entries)) return null;
      return cache;
    } catch {
      return null;
    }
  }
}

interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp?: bigint | null;
}
