import { renameSync, writeFileSync } from "node:fs";

import type { Action, VaultState } from "./types.js";

const BPS = 10_000n;
/**
 * How long an ask request stays valid. The keeper renews it every tick it waits and once more when it goes, so the ask
 * outlives the few seconds the vault's order takes to land; after that the pending buy keeps it up until the sync.
 */
const REQUEST_TTL_MS = 8_000;

export interface GateConfig {
  /** Hyperliquid info API; null turns the gate off (the local stack's MockHyperCore fills everything). */
  readonly hlInfoUrl: string | null;
  readonly coin: string;
  /** Where the keeper asks the market maker for an ask (packages/bots reads it). */
  readonly requestFile: string | null;
}

export type GateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly needNvda: number };

/**
 * Core size units the vault will buy on HyperCore with this action (0 if it buys nothing). An unwind buys back the
 * over-short there already is plus the chunk it sells: up to `maxUnhedged`, but the pool's 0.5% impact cap usually
 * stops it far sooner, so the chunk counts at most `chunkUnits`. A partial fill is fine: the rest stays over-short,
 * inside the tolerance, and goes into the next round's buy.
 */
export function buyNeeded(
  action: Action,
  state: VaultState,
  szDecimals: number,
  chunkUnits: bigint,
  /** The vault's live position on HyperCore (precompile), when known: a sync only buys if it's still over-short. */
  coreSzi: bigint | null = null,
): bigint {
  if (action.kind === "syncHedge") {
    if (state.pendingHedge.delta <= 0n) return 0n;
    if (coreSzi === null) return state.pendingHedge.delta;
    // what syncHedge would resend: the gap to −inventory, unless it's within the vault's tolerance (then it just confirms)
    const held = state.inventory / 10n ** BigInt(18 - szDecimals);
    const gap = -held - coreSzi; // > 0: still more short than stock
    const tolerance = held > 0n ? state.risk.maxUnhedged : 0n;
    return gap > tolerance ? gap : 0n;
  }
  if (action.kind !== "unwindStep") return 0n;
  const held = state.inventory / 10n ** BigInt(18 - szDecimals);
  const overShort = -held - state.confirmedShort; // > 0: short bigger than the stock
  let chunk = held < state.risk.maxUnhedged ? held : state.risk.maxUnhedged;
  if (chunk > chunkUnits) chunk = chunkUnits;
  return (overShort > 0n ? overShort : 0n) + chunk;
}

/**
 * A buy-back is an IOC on HyperCore: if no ask sits within the vault's cap (oracle + hedgeCapBps) when it lands, it
 * is rejected, and an unwind has already sold the stock by then. So before an unwind or a buy retry, look at the book;
 * without enough there, wait, and leave the market maker a request for the size.
 */
export async function checkBuyLiquidity(
  cfg: GateConfig,
  needUnits: bigint,
  szDecimals: number,
  hedgeCapBps: bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<GateResult> {
  if (cfg.hlInfoUrl === null || needUnits <= 0n) return { ok: true };
  const needNvda = Number(needUnits) / 10 ** szDecimals;
  const post = async <T>(body: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(cfg.hlInfoUrl as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HL info ${String(body.type)} → ${res.status}`);
    return (await res.json()) as T;
  };
  const dex = cfg.coin.includes(":") ? cfg.coin.split(":")[0] : "";
  const [[meta, ctxs], book] = await Promise.all([
    post<[{ universe: { name: string }[] }, { oraclePx: string }[]]>({ type: "metaAndAssetCtxs", dex }),
    post<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: "l2Book", coin: cfg.coin }),
  ]);
  const i = meta.universe.findIndex((u) => u.name === cfg.coin);
  const oracle = Number(ctxs[i]?.oraclePx);
  if (!(oracle > 0)) return { ok: false, reason: "no-oracle", needNvda };
  const cap = oracle * (1 + Number(hedgeCapBps) / Number(BPS));
  const available = book.levels[1].filter((l) => Number(l.px) <= cap).reduce((sum, l) => sum + Number(l.sz), 0);
  if (cfg.requestFile !== null) {
    const tmp = `${cfg.requestFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sizeNvda: needNvda, until: Date.now() + REQUEST_TTL_MS }));
    renameSync(tmp, cfg.requestFile);
  }
  return available + 1e-9 >= needNvda ? { ok: true } : { ok: false, reason: "waiting-for-ask", needNvda };
}
