import type { PublicClient } from "viem";
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
import { LogScanner } from "./logs.js";

const HISTORY_KEPT = 3600;
const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface CollectorOptions {
  /** Hyperliquid info API; null on the local stack, where the panel comes from MockHyperCore's precompiles. */
  hlInfoUrl: string | null;
  explorerUrl: string;
  fromBlock: bigint | null;
  /** eth_getLogs client when it isn't the main one (Alchemy's HyperEVM testnet has no eth_getLogs). */
  logsClient?: PublicClient;
  /** Minimum gap between log scans: a public logs RPC allows ~100 requests a minute. */
  logScanMs?: number;
}

const LOGS_RPC_LAG = 2n;

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
    this.logs = new LogScanner(opts.logsClient ?? client, dep, opts.fromBlock);
  }

  private nextLogScanAt = 0;

  get deployment(): DeploymentFile {
    return this.dep;
  }

  /** After the replay's setup redeploys: new addresses, so a fresh feed and history. */
  reload(dep: DeploymentFile) {
    this.dep = dep;
    this.logs = new LogScanner(this.opts.logsClient ?? this.client, dep, this.opts.fromBlock);
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
      const chain = await readChain(this.client, this.dep);
      if (this.latest !== null && chain.blockNumber < BigInt(this.latest.blockNumber)) this.history = []; // anvil revert
      // a separate logs RPC can sit a block behind the main one, and refuses a range past its own head
      await this.scanLogs(chain.blockNumber - LOGS_RPC_LAG);
      const snapshot = snapshotSchema.parse(this.build(chain, await this.panel(chain)));
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

  /** A failed eth_getLogs (public RPCs rate-limit them) leaves the feed a poll behind instead of failing the snapshot. */
  private async scanLogs(head: bigint) {
    if (Date.now() < this.nextLogScanAt) return;
    this.nextLogScanAt = Date.now() + (this.opts.logScanMs ?? 0);
    try {
      await this.logs.scan(head);
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

    return {
      updatedAt: Date.now(),
      blockNumber: chain.blockNumber.toString(),
      markets: chain.markets.map((m) => this.market(m)),
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
      activity: this.logs.activity,
    };
  }

  /** Borrow shares → assets rounded up and the health check exactly as Morpho Blue does them. */
  private market(m: MarketRead): MarketSnapshot {
    const debt =
      m.borrowShares === 0n
        ? 0n
        : (m.borrowShares * (m.totalBorrowAssets + 1n) + m.totalBorrowShares + 1_000_000n - 1n) /
          (m.totalBorrowShares + 1_000_000n);
    const collateralValue = (m.collateral * m.price) / ORACLE_SCALE;
    return {
      name: m.name,
      lltv: Number(m.lltv) / 1e18,
      totalBorrow: m.totalBorrowAssets.toString(),
      totalCollateral: m.collateral.toString(), // Morpho keeps no market total: the demo borrower's collateral
      borrower: {
        address: m.borrower ?? ZERO_ADDRESS,
        debt: debt.toString(),
        collateral: m.collateral.toString(),
        ltv: collateralValue === 0n ? 0 : Number(debt) / Number(collateralValue),
        healthy: (collateralValue * m.lltv) / WAD >= debt,
      },
      badDebt: (this.logs.badDebt.get(m.name) ?? 0n).toString(),
      oraclePrice: morphoPxToNumber(m.price),
    };
  }
}
