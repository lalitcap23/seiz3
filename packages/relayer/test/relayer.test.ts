import { describe, expect, it } from "vitest";
import type { PublicClient, WalletClient } from "viem";

import { Relayer } from "../src/relayer.js";
import type { CoreState, GatewayOrder, HyperCoreBackend, PlaceResult } from "../src/types.js";

const GATEWAY = "0x00000000000000000000000000000000000000aa" as const;

/** A gateway in memory: orders, acks and the last snapshot, as HyperCoreGateway keeps them. */
class FakeGateway {
  actionCount = 0n;
  executedNonce = 0n;
  observedAt = 0n;
  orders = new Map<bigint, Omit<GatewayOrder, "nonce">>();
  relays: { observedAt: bigint; executedNonce: bigint }[] = [];

  add(o: Partial<Omit<GatewayOrder, "nonce">> = {}) {
    this.actionCount += 1n;
    this.orders.set(this.actionCount, {
      asset: 750_002,
      isBuy: false,
      limitPx: 21_000_000_000n,
      sz: 100_000_000n,
      reduceOnly: false,
      tif: 3,
      cloid: 7n + this.actionCount,
      requestedAt: 0n,
      ...o,
    });
  }

  client(): PublicClient {
    return {
      readContract: async ({ functionName, args }: { functionName: string; args: bigint[] }) => {
        if (functionName === "actionCount") return this.actionCount;
        if (functionName === "executedNonce") return this.executedNonce;
        if (functionName === "orders") return this.orders.get(args[0]!);
        throw new Error(functionName);
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
    } as unknown as PublicClient;
  }

  wallet(): WalletClient {
    return {
      account: { address: "0x0000000000000000000000000000000000000001" },
      chain: undefined,
      writeContract: async ({ args }: { args: [CoreState & { executedNonce: bigint }] }) => {
        const [s] = args;
        if (s.executedNonce > this.actionCount) throw new Error("BadAck");
        if (s.executedNonce > this.executedNonce) this.executedNonce = s.executedNonce;
        if (s.observedAt > this.observedAt) this.observedAt = s.observedAt;
        this.relays.push({ observedAt: s.observedAt, executedNonce: s.executedNonce });
        return `0x${"ab".repeat(32)}`;
      },
    } as unknown as WalletClient;
  }
}

class FakeBackend implements HyperCoreBackend {
  readonly name = "fake";
  readonly account = "0x0000000000000000000000000000000000000002" as const;
  placed: GatewayOrder[] = [];
  clock = 1_000n;
  fail = false;

  async snapshot(): Promise<CoreState> {
    this.clock += 1n;
    return {
      observedAt: this.clock,
      szi: -BigInt(this.placed.length) * 1000n,
      entryNtl: 0n,
      accountValue: 120_000_000n,
      marginUsed: 0n,
      ntlPos: 0n,
      spotUsdcWei: 0n,
      oraclePx: 212_000n,
      markPx: 212_000n,
      leverage: 3,
      exists: true,
    };
  }

  async place(o: GatewayOrder): Promise<PlaceResult> {
    if (this.fail) throw new Error("hyperliquid down");
    this.placed.push(o);
    return { status: "filled", size: "1", avgPx: "212" };
  }
}

function setup(heartbeatMs = 10_000) {
  const gateway = new FakeGateway();
  const backend = new FakeBackend();
  let now = 0;
  const logs: string[] = [];
  const relayer = new Relayer(
    gateway.client(),
    gateway.wallet(),
    GATEWAY,
    backend,
    { heartbeatMs, settleDelayMs: 0, now: () => now, sleep: async () => {} },
    (event) => logs.push(event),
  );
  return { gateway, backend, relayer, advance: (ms: number) => (now += ms), logs };
}

describe("Relayer", () => {
  it("places a new order once and acknowledges it with a snapshot taken after", async () => {
    const { gateway, backend, relayer } = setup();
    gateway.add();
    expect(await relayer.tick()).toBe("orders");
    expect(backend.placed.map((o) => o.nonce)).toEqual([1n]);
    expect(backend.placed[0]!.cloid).toBe(8n);
    expect(gateway.executedNonce).toBe(1n);
    expect(gateway.relays.at(-1)).toEqual({ observedAt: 1_001n, executedNonce: 1n });
  });

  it("places every order past the acknowledgement, in order", async () => {
    const { gateway, backend, relayer } = setup();
    gateway.add();
    gateway.add({ isBuy: true, reduceOnly: true });
    await relayer.tick();
    expect(backend.placed.map((o) => [o.nonce, o.isBuy])).toEqual([
      [1n, false],
      [2n, true],
    ]);
    expect(gateway.executedNonce).toBe(2n);
  });

  it("never places an order twice when its acknowledgement failed", async () => {
    const { gateway, backend, relayer } = setup();
    gateway.add();
    const write = gateway.wallet().writeContract;
    let fail = true;
    // the first relay transaction fails after the order went out
    (relayer as unknown as { wallet: WalletClient }).wallet = {
      ...gateway.wallet(),
      writeContract: async (p: never) => {
        if (fail) {
          fail = false;
          throw new Error("rpc timeout");
        }
        return write(p);
      },
    } as unknown as WalletClient;
    await expect(relayer.tick()).rejects.toThrow("rpc timeout");
    expect(gateway.executedNonce).toBe(0n);
    await relayer.tick();
    expect(backend.placed).toHaveLength(1);
    expect(gateway.executedNonce).toBe(1n);
  });

  it("leaves an order unacknowledged while HyperCore can't be reached", async () => {
    const { gateway, backend, relayer } = setup();
    gateway.add();
    backend.fail = true;
    await expect(relayer.tick()).rejects.toThrow("hyperliquid down");
    expect(gateway.executedNonce).toBe(0n);
    backend.fail = false;
    await relayer.tick();
    expect(gateway.executedNonce).toBe(1n);
  });

  it("heartbeats between orders", async () => {
    const { gateway, relayer, advance } = setup(10_000);
    expect(await relayer.tick()).toBe("heartbeat"); // the first pass always posts
    advance(3_000);
    expect(await relayer.tick()).toBe("idle");
    advance(7_000);
    expect(await relayer.tick()).toBe("heartbeat");
    expect(gateway.relays).toHaveLength(2);
    expect(gateway.relays.every((r) => r.executedNonce === 0n)).toBe(true);
  });
});
