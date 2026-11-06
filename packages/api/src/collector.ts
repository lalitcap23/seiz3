import type { Address, PublicClient } from "viem";
import {
  morphoPxToNumber,
  snapshotSchema,
  type HistoryPoint,
  type HyperliquidPanel,
  type MarketSnapshot,
  type Snapshot,
} from "@afterbell/shared";
import { readChain, type ChainRead, type MarketRead } from "./chain.js";
import type { DeploymentFile } from "@afterbell/shared/node";
import { panelFromApi, panelFromCore } from "./hyperliquid.js";
import { LogScanner, type LogScannerOptions } from "./logs.js";
import { buildOperations, type CoreFill } from "./operations.js";

const HISTORY_KEPT = 3600;
const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface CollectorOptions {
  /** Hyperliquid info API; null on the local stack, where the panel comes from MockHyperCore's precompiles. */
  hlInfoUrl: string | null;
  explorerUrl: string;
  fromBlock: bigint | null;
  /** The activity feed's history reader, cache and anvil rewinds (logs.ts); the new blocks come from the main client. */
  logs?: LogScannerOptions;
  /** Testers to read positions for besides the deployment's (the API's watch list). */
  extraBorrowers?: () => readonly Address[];
}

/** Positions read per market each poll, riskiest shown first. */
const MAX_BORROWERS = 100;
/** The operations the snapshot carries (plus LIQ-0): the feed and /try only need the recent ones. */
const OPERATIONS_KEPT = 40;
const FILLS_EVERY_MS = 5_000;
const INFO_TIMEOUT_MS = 5_000;

/** Polls HyperEVM (one multicall) + Hyperliquid info API every second; keeps latest snapshot in memory. */
export class Collector {
  latest: Snapshot | null = null; // null until the first poll lands: /snapshot answers 503, the web shows its fixture
  history: HistoryPoint[] = [];
  lastError: string | null = null;
  logError: string | null = null;
  private listeners = new Set<(s: Snapshot) => void>();
  private logs: LogScanner;

  constructor(
    private readonly client: PublicClient,
    private dep: DeploymentFile,
    private readonly opts: CollectorOptions,
  ) {
    this.logs = new LogScanner(client, dep, opts.fromBlock, opts.logs);
  }

  private fills: CoreFill[] = [];
  private nextFillsAt = 0;

  get deployment(): DeploymentFile {
    return this.dep;
  }

  /** After the replay's setup redeploys: new addresses, so a fresh feed and history. */
  reload(dep: DeploymentFile) {
    this.dep = dep;
    this.logs.stop();
    this.logs = new LogScanner(this.client, dep, this.opts.fromBlock, this.opts.logs);
    this.history = [];
    this.latest = null;
  }

  /** Polls back to back, never overlapping: a slow RPC stretches the interval instead of stacking requests. */
  start(intervalMs = 1000) {
    const loop = async () => {
      const started = Date.now();
      await this.poll();
      setTimeout(() => void loop(), Math.max(0, intervalMs - (Date.now() - started)));
    };
    void loop();
  }

  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async poll() {
    try {
      const [chain, latest] = await Promise.all([
        readChain(this.client, this.dep, this.borrowers()),
        this.client.getBlockNumber({ cacheTime: 0 }).catch(() => null),
      ]);
      if (this.latest !== null && chain.blockNumber < BigInt(this.latest.blockNumber)) {
        // HyperEVM never goes back: a load-balanced RPC's lagging node answered, and the page keeps the newer snapshot
        if (!this.opts.logs?.chainRewinds) return;
        this.history = []; // anvil revert
      }
      // HyperEVM runs eth_call in the next block's context (block.number = latest + 1), and eth_getLogs refuses a block
      // that isn't there yet: the logs go up to the latest one, so a new unwind lands with the stock it sold
      const head = latest === null ? chain.blockNumber - 1n : latest < chain.blockNumber ? latest : chain.blockNumber;
      const [hyperliquid] = await Promise.all([this.panel(chain), this.refreshFills(), this.followLogs(head)]);
      const snapshot = snapshotSchema.parse(this.build(chain, hyperliquid));
      this.latest = snapshot;
      this.history.push({
        t: snapshot.updatedAt,
        inventory: Number(chain.vault.inventory) / 1e18,
        short: Math.abs(Number(chain.vault.confirmedShort)) / 10 ** this.dep.hypercore.szDecimals,
        hedgeRatio: snapshot.vault.hedgeRatio,
        sharePrice: snapshot.vault.sharePrice,
      });
      if (this.history.length > HISTORY_KEPT) this.history.shift();
      for (const fn of this.listeners) fn(snapshot);
      if (this.lastError !== null) console.log(`[api] recovered at block ${chain.blockNumber}`);
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? String(err) : String(err);
      if (message !== this.lastError) console.error(`[api] poll failed: ${message}`);
      this.lastError = message;
    }
  }

  /** Deployment borrowers, /try and faucet testers, and everyone with a Borrow event: deduplicated, capped. */
  private borrowers(): Address[] {
    const seen = new Map<string, Address>();
    const add = (a: string) => seen.set(a.toLowerCase(), a as Address);
    for (const b of this.dep.borrowers) add(b.address);
    for (const a of this.opts.extraBorrowers?.() ?? []) add(a);
    for (const a of this.logs.borrowers) add(a);
    return [...seen.values()].slice(0, MAX_BORROWERS);
  }

  /** The vault's HyperCore fills (they carry our cloids), every few seconds; a failure keeps the last ones. */
  private async refreshFills() {
    if (this.opts.hlInfoUrl === null || Date.now() < this.nextFillsAt) return;
    this.nextFillsAt = Date.now() + FILLS_EVERY_MS;
    try {
      const res = await fetch(this.opts.hlInfoUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "userFills", user: this.dep.vault }),
        signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
      });
      if (res.ok) this.fills = (await res.json()) as CoreFill[];
    } catch {
      // keep the last fills
    }
  }

  /** A failed eth_getLogs leaves the feed a poll behind (the snapshot says so) instead of failing the snapshot. */
  private async followLogs(head: bigint) {
    try {
      await this.logs.follow(head);
      if (this.logError !== null) console.log("[api] log scan recovered");
      this.logError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? String(err) : String(err);
      if (message !== this.logError) console.error(`[api] log scan failed, retrying next poll: ${message}`);
      this.logError = message;
    }
  }

  /** Info API on testnet/mainnet (null when unreachable: the stale badge); precompiles on the local stack. */
  private async panel(chain: ChainRead): Promise<HyperliquidPanel | null> {
    const szDecimals = this.dep.hypercore.szDecimals;
    if (this.opts.hlInfoUrl === null) {
      return chain.core ? panelFromCore(chain.core, szDecimals, this.opts.explorerUrl) : null;
    }
    try {
      return await panelFromApi(this.opts.hlInfoUrl, this.dep.vault, chain.core, szDecimals, this.opts.explorerUrl);
    } catch {
      return null;
    }
  }

  private build(chain: ChainRead, hyperliquid: HyperliquidPanel | null): Snapshot {
    const { vault } = chain;
    // against the vault's own target (−inventory in Core size units), so the sub-unit dust the perp can't hold still reads 100%
    const target = vault.inventory / 10n ** BigInt(18 - this.dep.hypercore.szDecimals);
    const short = vault.confirmedShort < 0n ? -vault.confirmedShort : vault.confirmedShort;
    const totalAssets = vault.totalAssets ?? 0n;
    const shares = Number(vault.totalSupply) / 10 ** vault.decimals;
    const nvdaxIsCurrency0 = this.dep.poolKey.currency0.toLowerCase() === this.dep.nvdax.toLowerCase();
    // USDC per NVDAx: the v4 price is currency1 per currency0 in raw units (NVDAx 18 dec, USDC 6)
    const poolOut = (p: { sqrtPriceX96: bigint; liquidity: bigint }) => {
      const raw = p.sqrtPriceX96 === 0n ? 0 : (Number(p.sqrtPriceX96) / 2 ** 96) ** 2;
      return {
        price: raw === 0 ? 0 : nvdaxIsCurrency0 ? raw * 1e12 : 1e12 / raw,
        sqrtPriceX96: p.sqrtPriceX96.toString(),
        liquidity: p.liquidity.toString(),
      };
    };

    const { operations, opOf } = buildOperations(this.logs.all, this.fills, vault.inventory);
    const opByTx = new Map(operations.filter((o) => o.txHash !== "").map((o) => [o.txHash.toLowerCase(), o.id]));
    const kept = operations.length > OPERATIONS_KEPT + 1 ? operations.slice(-OPERATIONS_KEPT) : operations;
    const zero = operations[0]?.id === "LIQ-0" && kept[0]?.id !== "LIQ-0" ? [operations[0]] : [];

    return {
      updatedAt: Date.now(),
      blockNumber: chain.blockNumber.toString(),
      markets: chain.markets.map((m) => this.market(m, opByTx)),
      vault: {
        address: this.dep.vault,
        inventory: vault.inventory.toString(),
        confirmedShort: vault.confirmedShort.toString(),
        szDecimals: this.dep.hypercore.szDecimals,
        pendingHedge: {
          delta: vault.pendingHedge.delta.toString(),
          sentBlock: vault.pendingHedge.sentBlock.toString(),
          sentAt: Number(vault.pendingHedge.sentAt),
          tries: vault.pendingHedge.tries,
        },
        hedgeState: vault.hedgeState,
        // nothing held counts as fully hedged, so a liquidation shows as a dip from 100% and the sync as the snap back
        hedgeRatio: target === 0n ? 1 : Number(short) / Number(target),
        paused: vault.paused,
        totalAssets: totalAssets.toString(),
        totalSupply: vault.totalSupply.toString(),
        sharePrice: shares === 0 ? 1 : Number(totalAssets) / 1e6 / shares,
        marginFloat: vault.marginFloat.toString(),
      },
      hyperliquid,
      pool: poolOut(chain.pool),
      ...(chain.thinPool ? { thinPool: poolOut(chain.thinPool) } : {}),
      marketOpen: chain.marketOpen,
      activity: this.logs.activity.map((e) => {
        const opId = opOf.get(e);
        return opId === undefined ? e : { ...e, opId };
      }),
      operations: [...zero, ...kept],
      feed: this.logs.status(),
    };
  }

  /** Borrow shares → assets rounded up and the health check exactly as Morpho Blue does them. */
  private market(m: MarketRead, opByTx: Map<string, string>): MarketSnapshot {
    const row = (address: string, borrowShares: bigint, collateral: bigint) => {
      const debt =
        borrowShares === 0n
          ? 0n
          : (borrowShares * (m.totalBorrowAssets + 1n) + m.totalBorrowShares + 1_000_000n - 1n) /
            (m.totalBorrowShares + 1_000_000n);
      const collateralValue = (collateral * m.price) / ORACLE_SCALE;
      return {
        address,
        debt: debt.toString(),
        collateral: collateral.toString(),
        collateralValue: collateralValue.toString(),
        ltv: collateralValue === 0n ? (debt > 0n ? Infinity : 0) : Number(debt) / Number(collateralValue),
        healthy: (collateralValue * m.lltv) / WAD >= debt,
      };
    };
    const borrowers = m.positions
      .map((p) => row(p.address, p.borrowShares, p.collateral))
      .sort((a, b) => b.ltv - a.ltv);
    const demo = row(m.borrower ?? ZERO_ADDRESS, m.borrowShares, m.collateral);
    // the column's headline: the riskiest open loan, else the deployment's demo borrower
    const headline = borrowers.find((b) => BigInt(b.debt) > 0n) ?? demo;
    return {
      name: m.name,
      lltv: Number(m.lltv) / 1e18,
      totalBorrow: m.totalBorrowAssets.toString(),
      // Morpho keeps no market total of collateral: the sum over the borrowers we know
      totalCollateral: borrowers.reduce((s, b) => s + BigInt(b.collateral), 0n).toString(),
      borrower: { ...headline, ltv: Number.isFinite(headline.ltv) ? headline.ltv : 0 },
      badDebt: (this.logs.badDebt.get(m.name) ?? 0n).toString(),
      oraclePrice: morphoPxToNumber(m.price),
      borrowers: borrowers.map((b) => ({ ...b, ltv: Number.isFinite(b.ltv) ? b.ltv : 99 })),
      liquidations: (this.logs.liquidations.get(m.name) ?? [])
        .slice(-10)
        .map((l) => ({ ...l, opId: opByTx.get(l.txHash.toLowerCase()) ?? null })),
    };
  }
}
