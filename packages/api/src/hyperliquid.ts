import { corePxToNumber, hl, PERP_COIN, type HyperliquidPanel } from "@seiz3/shared";
import type { Address } from "viem";
import type { CoreRead } from "./chain.js";

const USD = 1e6; // the gateway's (precompile-shaped) USD values have 6 decimals

/** The panel from the gateway's reads alone: the local stack, where MockHyperCore stands in for the info API. */
export function panelFromCore(core: CoreRead, szDecimals: number, explorerUrl: string): HyperliquidPanel {
  const size = Number(core.szi) / 10 ** szDecimals;
  const entry = Number(core.entryNtl) / USD;
  const markPx = corePxToNumber(core.markPx, szDecimals);
  return {
    coin: PERP_COIN,
    size,
    entryPx: size === 0 ? null : entry / Math.abs(size),
    unrealizedPnl: size === 0 ? 0 : size < 0 ? entry - -size * markPx : size * markPx - entry,
    marginUsed: Number(core.marginUsed) / USD,
    accountValue: Number(core.accountValue) / USD,
    markPx,
    oraclePx: corePxToNumber(core.oraclePx, szDecimals),
    explorerUrl,
  };
}

/** The panel from Hyperliquid's info API (`clearinghouseState`, dex xyz); prices from the gateway. */
export async function panelFromApi(
  url: string,
  account: Address,
  core: CoreRead | null,
  szDecimals: number,
  explorerUrl: string,
): Promise<HyperliquidPanel> {
  const state = await hl(url).clearinghouseState(account);
  const position = state.assetPositions.find((p) => p.position.coin === PERP_COIN)?.position;
  return {
    coin: PERP_COIN,
    size: position ? Number(position.szi) : 0,
    entryPx: position?.entryPx ? Number(position.entryPx) : null,
    unrealizedPnl: position ? Number(position.unrealizedPnl) : 0,
    marginUsed: Number(state.marginSummary.totalMarginUsed),
    accountValue: Number(state.marginSummary.accountValue),
    markPx: core ? corePxToNumber(core.markPx, szDecimals) : 0,
    oraclePx: core ? corePxToNumber(core.oraclePx, szDecimals) : 0,
    explorerUrl,
  };
}
