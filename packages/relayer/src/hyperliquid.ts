import { ApiRequestError, ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import type { CoreState, GatewayOrder, HyperCoreBackend, PlaceResult } from "./types.js";
import { abs, cloidHex, decToBig, wireToDec } from "./units.js";

export interface ClearinghouseLike {
  time: number;
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  assetPositions: { position: { coin: string; szi: string; entryPx: string | null; leverage: { value: number } } }[];
}

export interface AssetCtxLike {
  oraclePx: string;
  markPx: string;
}

/**
 * Hyperliquid's view of the hedge account in the gateway's units (the precompiles'): sizes in Core units, prices in
 * raw perp px (6 − szDecimals decimals), USD with 6 decimals, spot USDC with 8. Pure, so it is unit-tested.
 */
export function toCoreState(
  state: ClearinghouseLike,
  ctx: AssetCtxLike,
  spotUsdc: string,
  coin: string,
  szDecimals: number,
  exists: boolean,
): CoreState {
  const pxDecimals = 6 - szDecimals;
  const position = state.assetPositions.find((p) => p.position.coin === coin)?.position;
  const szi = position ? decToBig(position.szi, szDecimals) : 0n;
  const entryPx = position?.entryPx ? decToBig(position.entryPx, pxDecimals) : 0n;
  return {
    observedAt: BigInt(Math.floor(state.time / 1000)),
    szi,
    entryNtl: abs(szi) * entryPx, // size units × raw px = USD, 6 decimals
    accountValue: decToBig(state.marginSummary.accountValue, 6),
    marginUsed: decToBig(state.marginSummary.totalMarginUsed, 6),
    ntlPos: decToBig(state.marginSummary.totalNtlPos, 6),
    spotUsdcWei: decToBig(spotUsdc, 8),
    oraclePx: decToBig(ctx.oraclePx, pxDecimals),
    markPx: decToBig(ctx.markPx, pxDecimals),
    leverage: position?.leverage.value ?? 0,
    exists,
  };
}

/**
 * The hedge account on Hyperliquid: the relayer signs the vault's orders with its key (or an API wallet it approved)
 * and reads the account back through the info API.
 */
export class HyperliquidBackend implements HyperCoreBackend {
  readonly name = "hyperliquid";
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient;
  private known = false; // the account exists on HyperCore (never goes back)

  constructor(
    privateKey: Hex,
    readonly account: Address,
    private readonly opts: { testnet: boolean; dex: string; coin: string; szDecimals: number },
  ) {
    const transport = new HttpTransport({ isTestnet: opts.testnet });
    this.info = new InfoClient({ transport });
    this.exchange = new ExchangeClient({ transport, wallet: privateKeyToAccount(privateKey) });
  }

  async snapshot(): Promise<CoreState> {
    const [state, [meta, ctxs], spot, exists] = await Promise.all([
      this.info.clearinghouseState({ user: this.account, dex: this.opts.dex }),
      this.info.metaAndAssetCtxs({ dex: this.opts.dex }),
      this.info.spotClearinghouseState({ user: this.account }),
      this.exists(),
    ]);
    const i = meta.universe.findIndex((u) => u.name === this.opts.coin);
    const ctx = ctxs[i];
    if (i < 0 || ctx === undefined) throw new Error(`${this.opts.coin} not in ${this.opts.dex}'s meta`);
    const usdc = spot.balances.find((b) => b.coin === "USDC")?.total ?? "0";
    return toCoreState(state, ctx, usdc, this.opts.coin, this.opts.szDecimals, exists);
  }

  async place(o: GatewayOrder): Promise<PlaceResult> {
    const cloid = cloidHex(o.cloid);
    // a restart between placing and acknowledging must not send the order twice: HyperCore knows its cloid
    const status = await this.info.orderStatus({ user: this.account, oid: cloid });
    if (status.status === "order") return { status: "duplicate" };

    const size = wireToDec(o.sz);
    try {
      const res = await this.exchange.order({
        orders: [
          {
            a: o.asset,
            b: o.isBuy,
            p: wireToDec(o.limitPx),
            s: size,
            r: o.reduceOnly,
            t: { limit: { tif: "Ioc" } },
            c: cloid,
          },
        ],
        grouping: "na",
      });
      const s = res.response.data.statuses[0];
      if (s !== undefined && typeof s === "object" && "filled" in s) {
        const filled = { size: s.filled.totalSz, avgPx: s.filled.avgPx };
        return Number(filled.size) < Number(size) ? { status: "partial", ...filled } : { status: "filled", ...filled };
      }
      return { status: "rejected", reason: JSON.stringify(s) };
    } catch (error) {
      // an IOC that crosses nothing, a size under the $10 minimum, low margin: HyperCore answered, nothing filled
      if (error instanceof ApiRequestError) return { status: "rejected", reason: error.message };
      throw error; // no answer: try again next tick (orderStatus above keeps it from filling twice)
    }
  }

  private async exists(): Promise<boolean> {
    if (this.known) return true;
    const role = await this.info.userRole({ user: this.account });
    this.known = role.role !== "missing";
    return this.known;
  }
}
