import type { Address, Hash, PublicClient, WalletClient } from "viem";
import { hyperCoreGatewayAbi } from "@seiz3/shared/abis";

import type { CoreState, GatewayOrder, HyperCoreBackend, PlaceResult } from "./types.js";

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface RelayerOptions {
  readonly heartbeatMs: number;
  readonly settleDelayMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The relayer between HyperCoreGateway (on the vault's chain) and the hedge account on HyperCore:
 *   1. every order the gateway holds past `executedNonce` is placed on HyperCore, once, with the vault's cloid;
 *   2. the account is then read back and posted with `executedNonce = actionCount`, which `syncHedge` waits for;
 *   3. between orders, a snapshot every `heartbeatMs` keeps the gateway's state and oracle fresh.
 * Orders come from the gateway's storage, not its logs, so a restart or a rate-limited RPC can't make it miss one.
 */
export class Relayer {
  private readonly results = new Map<bigint, PlaceResult>();
  private lastPostMs = Number.NEGATIVE_INFINITY; // the first pass always posts
  private lastObserved = -1n;
  private lastAck = -1n;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: PublicClient,
    private readonly wallet: WalletClient,
    private readonly gateway: Address,
    private readonly backend: HyperCoreBackend,
    private readonly opts: RelayerOptions,
    private readonly log: Log,
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One pass. Returns what it did, for logs and tests. */
  async tick(): Promise<"orders" | "heartbeat" | "idle"> {
    const [count, executed] = await Promise.all([this.read<bigint>("actionCount"), this.read<bigint>("executedNonce")]);
    if (executed < count) {
      for (let n = executed + 1n; n <= count; n++) {
        if (this.results.has(n)) continue; // placed already; its ack didn't land yet
        const order = await this.order(n);
        const result = await this.backend.place(order);
        this.results.set(n, result);
        this.log("order", {
          nonce: n,
          side: order.isBuy ? "buy" : "sell",
          reduceOnly: order.reduceOnly,
          sz: order.sz,
          limitPx: order.limitPx,
          cloid: `0x${order.cloid.toString(16).padStart(32, "0")}`,
          ...result,
        });
      }
      if (this.opts.settleDelayMs > 0) await this.sleep(this.opts.settleDelayMs);
      await this.post(count);
      return "orders";
    }
    if (this.now() - this.lastPostMs >= this.opts.heartbeatMs) {
      await this.post(executed);
      return "heartbeat";
    }
    return "idle";
  }

  /** Post the hedge account as HyperCore shows it now, acknowledging orders up to `executedNonce`. */
  async post(executedNonce: bigint): Promise<Hash | null> {
    const s = await this.backend.snapshot();
    this.lastPostMs = this.now();
    // the gateway keeps only newer observations; an acknowledgement is worth sending regardless
    if (s.observedAt <= this.lastObserved && executedNonce <= this.lastAck) return null;
    const hash = await this.wallet.writeContract({
      address: this.gateway,
      abi: hyperCoreGatewayAbi,
      functionName: "relay",
      args: [{ ...s, executedNonce }],
      account: this.wallet.account!,
      chain: this.wallet.chain,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`relay reverted: ${hash}`);
    this.lastObserved = s.observedAt > this.lastObserved ? s.observedAt : this.lastObserved;
    this.lastAck = executedNonce;
    this.log("snapshot", snapshotFields(s, executedNonce, hash));
    return hash;
  }

  private async order(nonce: bigint): Promise<GatewayOrder> {
    const o = await this.read<Omit<GatewayOrder, "nonce">>("orders", [nonce]);
    return { nonce, ...o };
  }

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.gateway, abi: hyperCoreGatewayAbi, functionName, args } as never) as Promise<T>;
  }
}

export function snapshotFields(s: CoreState, executedNonce: bigint, tx: Hash): Record<string, unknown> {
  return {
    observedAt: s.observedAt,
    szi: s.szi,
    accountValue: s.accountValue,
    oraclePx: s.oraclePx,
    exists: s.exists,
    executedNonce,
    tx,
  };
}
