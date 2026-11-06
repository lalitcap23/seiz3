import { parseAbiItem, toHex, type AbiEvent, type Address, type PublicClient } from "viem";
import { afterbellVaultAbi, naiveLiquidatorAbi } from "@afterbell/shared/abis";
import type { ActivityEvent, MarketName } from "@afterbell/shared";
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
const vaultEvents = afterbellVaultAbi.filter(
  (item): item is Extract<(typeof afterbellVaultAbi)[number], { type: "event" }> =>
    item.type === "event" && ACTIVITY.includes(item.name),
);
const shortfall = naiveLiquidatorAbi.find(
  (item): item is Extract<(typeof naiveLiquidatorAbi)[number], { type: "event"; name: "Shortfall" }> =>
    item.type === "event" && item.name === "Shortfall",
);

/** HyperEVM's RPC caps eth_getLogs at 1000 blocks, and the public testnet one rejects 999 as "rate limited"; 500 passes. */
const PAGE = 500n;
/** A long backfill catches up over several polls instead of stalling one. */
const PAGES_PER_SCAN = 2;
const DEFAULT_LOOKBACK = 10_000n;

const plain = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

/**
 * The activity feed (vault events) and each market's bad debt: Morpho's realised `badDebtAssets`, plus, for market A,
 * the shortfall NaiveLiquidator covers so its transaction succeeds ("bad debt the lenders would have eaten").
 */
export class LogScanner {
  activity: ActivityEvent[] = [];
  readonly badDebt = new Map<MarketName, bigint>(MARKETS.map((m) => [m, 0n]));
  private next: bigint | null;
  private readonly times = new Map<bigint, number>();
  private readonly marketById: Map<string, MarketName>;
  private readonly addresses: Address[];
  private readonly events: AbiEvent[];

  constructor(
    private readonly client: PublicClient,
    private readonly dep: DeploymentFile,
    private readonly fromBlock: bigint | null,
  ) {
    this.next = fromBlock;
    this.marketById = new Map(MARKETS.map((m) => [dep.markets[m].id.toLowerCase(), m]));
    this.addresses = [dep.vault, dep.morpho, ...(dep.naiveLiquidator ? [dep.naiveLiquidator] : [])];
    this.events = [...vaultEvents, morphoLiquidate, ...(shortfall ? [shortfall] : [])] as AbiEvent[];
  }

  async scan(head: bigint): Promise<void> {
    if (this.next !== null && this.next > head + 1n) this.reset(); // the chain went back (an anvil revert)
    let from = this.next ?? (head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n);
    for (let page = 0; page < PAGES_PER_SCAN && from <= head; page++) {
      const to = from + PAGE - 1n < head ? from + PAGE - 1n : head;
      const logs = await this.client.getLogs({ address: this.addresses, events: this.events, fromBlock: from, toBlock: to });
      for (const log of logs) await this.apply(log as unknown as DecodedLog);
      from = to + 1n;
      this.next = from;
    }
  }

  private async apply(log: DecodedLog): Promise<void> {
    const from = log.address.toLowerCase();
    if (from === this.dep.morpho.toLowerCase()) {
      const market = this.marketById.get(String(log.args.id).toLowerCase());
      if (market !== undefined) this.addBadDebt(market, log.args.badDebtAssets as bigint);
      return;
    }
    if (from === this.dep.naiveLiquidator?.toLowerCase()) {
      this.addBadDebt("A_naive", log.args.shortfall as bigint);
      return;
    }
    const cloid = log.args.cloid;
    this.activity.push({
      type: log.eventName as ActivityEvent["type"],
      txHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
      timestamp: await this.timeOf(log.blockNumber),
      ...(typeof cloid === "bigint" ? { cloid: toHex(cloid) } : {}),
      args: plain(log.args),
    });
    if (this.activity.length > ACTIVITY_KEPT) this.activity = this.activity.slice(-ACTIVITY_KEPT);
  }

  private reset(): void {
    this.activity = [];
    for (const m of MARKETS) this.badDebt.set(m, 0n);
    this.times.clear();
    this.next = this.fromBlock;
  }

  private addBadDebt(market: MarketName, amount: bigint): void {
    this.badDebt.set(market, (this.badDebt.get(market) ?? 0n) + amount);
  }

  private async timeOf(blockNumber: bigint): Promise<number> {
    let t = this.times.get(blockNumber);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber })).timestamp) * 1000;
      this.times.set(blockNumber, t);
    }
    return t;
  }
}

interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
}
