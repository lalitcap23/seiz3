import { readFileSync } from "node:fs";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { PERP_COIN, PERP_DEX } from "@afterbell/shared";
import { afterbellVaultAbi } from "@afterbell/shared/abis";
import { dep, log, read } from "./chain.js";
import { env } from "./env.js";

/** Hyperliquid rejects orders under $10 of notional. */
const MIN_ORDER_USD = 10;

/**
 * Quotes on xyz:NVDA a few bps around HyperCore's oracle, for the vault's IOC orders: its hedge sells at most 1% under
 * the oracle and its unwind buys back at most 1% over. Testnet's own book sits ~7% away, so without these the short
 * only half fills and the unwind can't fill at all.
 *
 * The bid rests all the time: a liquidation's hedge goes out in the liquidation tx itself. The ask only goes up when
 * the vault is about to buy: the keeper's liquidity gate asks for one before an unwind (ASK_REQUEST_FILE), or a buy is
 * pending. A testnet bot lifts any resting ask near the oracle every few seconds, which would otherwise run this
 * account short with nothing left for the vault.
 */
export class MarketMaker {
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient;
  private readonly user: Hex;
  private readonly asset = dep.hypercore.perpAsset;
  private readonly szDecimals = dep.hypercore.szDecimals;

  constructor(privateKey: Hex, account?: Hex) {
    const transport = new HttpTransport({ isTestnet: env.NETWORK === "testnet" });
    const wallet = privateKeyToAccount(privateKey);
    this.info = new InfoClient({ transport });
    this.exchange = new ExchangeClient({ transport, wallet });
    this.user = account ?? wallet.address;
  }

  async tick(): Promise<void> {
    const [[meta, ctxs], open, { szi, free, liqPx }, pending] = await Promise.all([
      this.info.metaAndAssetCtxs({ dex: PERP_DEX }),
      this.info.openOrders({ user: this.user, dex: PERP_DEX }),
      this.account(),
      read<readonly [bigint, bigint, bigint, number]>(dep.vault, afterbellVaultAbi, "pendingHedge"),
    ]);
    // > 0: the vault wants to buy back that many Core size units, now (pending) or in its next unwind (the request)
    const pendingBuy = pending[0] > 0n ? Number(pending[0]) / 10 ** this.szDecimals : 0;
    const requested = askRequest(env.ASK_REQUEST_FILE);
    const vaultBuys = Math.max(pendingBuy, requested);
    const askSize = vaultBuys > 0 ? vaultBuys + env.MM_ASK_BUFFER : 0;
    const i = meta.universe.findIndex((u) => u.name === PERP_COIN);
    const oracle = Number(ctxs[i]?.oraclePx);
    if (!(oracle > 0)) throw new Error(`no oracle price for ${PERP_COIN}`);

    const askRoom = this.askRoom(szi, free, liqPx, oracle);
    const mine = open.filter((o) => o.coin === PERP_COIN);
    const spread = env.MM_SPREAD_BPS / 10_000;
    for (const [isBuy, side] of [
      [true, "B"],
      [false, "A"],
    ] as const) {
      const target = this.roundPx(oracle * (isBuy ? 1 - spread : 1 + spread), isBuy);
      // the bid rests up to MM_MAX_POSITION long; the ask covers the vault's buy while the liquidation price allows
      const want = isBuy ? Math.min(env.MM_SIZE, env.MM_MAX_POSITION - szi) : Math.min(askSize, askRoom);
      const f = 10 ** this.szDecimals;
      let size = Math.floor(Math.max(0, want) * f) / f;
      // a vault buy under the $10 minimum still needs a quotable ask; its reduce-only IOC takes only what it needs
      if (!isBuy && size > 0 && size * oracle < MIN_ORDER_USD) {
        size = Math.min(Math.ceil((MIN_ORDER_USD / oracle) * f) / f, Math.floor(askRoom * f) / f);
      }
      const quotable = size * oracle >= MIN_ORDER_USD;
      const orders = mine.filter((o) => o.side === side);
      const keep = quotable
        ? orders.find(
            (o) =>
              Math.abs(Number(o.limitPx) - target) / target <= env.MM_REQUOTE_BPS / 10_000 &&
              // an ask the bot has bitten into is replaced only once it can no longer cover the vault
              Number(o.sz) >= (isBuy ? size / 2 : vaultBuys) &&
              Number(o.sz) <= size,
          )
        : undefined;
      const stale = orders.filter((o) => o !== keep);
      if (stale.length > 0) {
        await this.exchange.cancel({ cancels: stale.map((o) => ({ a: this.asset, o: o.oid })) });
      }
      if (keep !== undefined || !quotable) continue;
      // Gtc, not Alo: crossing a stray order on the other side just fills it at its (better) price
      const res = await this.exchange.order({
        orders: [
          { a: this.asset, b: isBuy, p: String(target), s: size.toFixed(this.szDecimals), r: false, t: { limit: { tif: "Gtc" } } },
        ],
        grouping: "na",
      });
      log("mm", `${isBuy ? "bid" : "ask"} ${size} @ ${target} (oracle ${oracle}, position ${szi})`, {
        status: res.response.data.statuses[0],
      });
    }
  }

  /**
   * NVDA position on the xyz DEX, and the USDC still free for margin. A unified account keeps its margin in spot
   * USDC, so there the xyz account value is only what's on hold; the spot "available after maintenance" is the room.
   */
  async account(): Promise<{ accountValue: number; free: number; szi: number; liqPx: number | null }> {
    const [s, spot] = await Promise.all([
      this.info.clearinghouseState({ user: this.user, dex: PERP_DEX }),
      this.info.spotClearinghouseState({ user: this.user }),
    ]);
    const p = s.assetPositions.find((a) => a.position.coin === PERP_COIN);
    const unified = spot.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0)?.[1];
    return {
      accountValue: Number(s.marginSummary.accountValue),
      free: unified === undefined ? Number(s.withdrawable) : Number(unified),
      szi: Number(p?.position.szi ?? 0),
      liqPx: p?.position.liquidationPx ? Number(p.position.liquidationPx) : null,
    };
  }

  /**
   * NVDA this account may still sell the vault. A short of size q is liquidated about slack / q above the oracle,
   * where slack = (liqPx − oracle) × q today; selling more spreads the same slack over a bigger short. So the short may
   * grow to slack / (MM_MIN_LIQ_DISTANCE × oracle). Long or flat, the free margin is the slack, and a long sells first.
   */
  private askRoom(szi: number, free: number, liqPx: number | null, oracle: number): number {
    const slack = szi < 0 && liqPx !== null ? (liqPx - oracle) * -szi : free;
    const maxShort = Math.max(0, slack) / (env.MM_MIN_LIQ_DISTANCE * oracle);
    const room = maxShort + szi; // szi < 0 uses up room, a long adds to it
    return Math.max(0, Math.min(room, env.MM_VAULT_MAX_SHORT + szi));
  }

  /** Hyperliquid perp prices: at most 5 significant figures and 6 − szDecimals decimals. Bids down, asks up. */
  private roundPx(px: number, down: boolean): number {
    const decimals = Math.min(6 - this.szDecimals, Math.max(0, 5 - Math.floor(Math.log10(px)) - 1));
    const f = 10 ** decimals;
    return (down ? Math.floor(px * f) : Math.ceil(px * f)) / f;
  }
}

/** NVDA the keeper wants on the ask for its next unwind, 0 if there's no live request. */
function askRequest(path: string): number {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as { sizeNvda?: number; until?: number };
    return typeof r.sizeNvda === "number" && typeof r.until === "number" && r.until > Date.now() ? r.sizeNvda : 0;
  } catch {
    return 0;
  }
}
