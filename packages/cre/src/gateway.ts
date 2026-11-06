// Base Sepolia: the vault lives on Base and its short on HyperCore, in a hedge account the relayer trades. The vault
// reads that account through HyperCoreGateway, which the relayer keeps up to date. This is the DON's independent
// observation of the same account: every node reads Hyperliquid's info API on its own, the DON takes the median of each
// field, and the signed snapshot lands in HyperCoreGateway.onReport. The gateway keeps whichever observation is newer,
// so a relayer that stops reporting (or reports something else) is overwritten by what the DON saw.

import { cre, ok, prepareReportRequest, text, type EVMClient, type NodeRuntime, type Runtime } from "@chainlink/cre-sdk";
import { encodeAbiParameters, type Address, type Hex } from "viem";

import type { HyperliquidConfig } from "./hyperliquid";

export interface GatewayConfig {
  readonly address: string; // HyperCoreGateway, on the chain RiskParams is on (cfg.evm)
  readonly hedgeAccount: string; // the HyperCore account that holds the vault's short
  readonly szDecimals: number;
  readonly gasLimit: string;
}

/** One node's view of the hedge account, in the gateway's (the precompiles') units. */
export interface HedgeAccountRead {
  readonly observedAt: number; // unix seconds, HyperCore's clock
  readonly szi: bigint; // Core size units
  readonly entryNtl: bigint; // USD 6 dec
  readonly accountValue: bigint; // USD 6 dec on the perp DEX
  readonly marginUsed: bigint;
  readonly ntlPos: bigint;
  readonly spotUsdcWei: bigint; // 8 dec
  readonly oraclePx: bigint; // raw perp px: 6 − szDecimals decimals
  readonly markPx: bigint;
  readonly leverage: number;
  readonly exists: number; // 1 / 0: the DON agrees on it exactly
}

interface Clearinghouse {
  readonly time: number; // ms
  readonly marginSummary: { readonly accountValue: string; readonly totalNtlPos: string; readonly totalMarginUsed: string };
  readonly assetPositions: readonly {
    readonly position: { readonly coin: string; readonly szi: string; readonly entryPx: string | null; readonly leverage?: { readonly value: number } };
  }[];
}

interface SpotState {
  readonly balances: readonly { readonly coin: string; readonly total: string }[];
}

type Ctxs = readonly [
  { readonly universe: readonly { readonly name: string }[] },
  readonly { readonly oraclePx: string; readonly markPx: string }[],
];

/** A signed decimal string ("-1.162") as an integer with `decimals` places; extra places are cut. */
export function parseSigned(value: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`not a decimal: ${value}`);
  const frac = (m[3] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const n = BigInt(m[2]!) * 10n ** BigInt(decimals) + BigInt(frac === "" ? "0" : frac);
  return m[1] === "-" ? -n : n;
}

function post<T>(nodeRuntime: NodeRuntime<unknown>, url: string, body: object): T {
  const response = new cre.capabilities.HTTPClient()
    .sendRequest(nodeRuntime, {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    })
    .result();
  if (!ok(response)) throw new Error(`hyperliquid ${JSON.stringify(body)}: HTTP ${response.statusCode}`);
  return JSON.parse(text(response)) as T;
}

/** Hyperliquid's answers → the gateway's snapshot fields. Pure, so it is unit-tested. */
export function toHedgeAccountRead(
  state: Clearinghouse,
  spot: SpotState,
  ctxs: Ctxs,
  coin: string,
  szDecimals: number,
): HedgeAccountRead {
  const pxDecimals = 6 - szDecimals;
  const i = ctxs[0].universe.findIndex((a) => a.name === coin);
  const ctx = i < 0 ? undefined : ctxs[1][i];
  if (ctx === undefined) throw new Error(`hyperliquid: no ${coin} in the dex's meta`);
  const position = state.assetPositions.find((p) => p.position.coin === coin)?.position;
  const szi = position ? parseSigned(position.szi, szDecimals) : 0n;
  const entryPx = position?.entryPx ? parseSigned(position.entryPx, pxDecimals) : 0n;
  const accountValue = parseSigned(state.marginSummary.accountValue, 6);
  const spotUsdcWei = parseSigned(spot.balances.find((b) => b.coin === "USDC")?.total ?? "0", 8);
  return {
    observedAt: Math.floor(state.time / 1000),
    szi,
    entryNtl: (szi < 0n ? -szi : szi) * entryPx,
    accountValue,
    marginUsed: parseSigned(state.marginSummary.totalMarginUsed, 6),
    ntlPos: parseSigned(state.marginSummary.totalNtlPos, 6),
    spotUsdcWei,
    oraclePx: parseSigned(ctx.oraclePx, pxDecimals),
    markPx: parseSigned(ctx.markPx, pxDecimals),
    leverage: position?.leverage?.value ?? 0,
    // HyperCore only shows balances or positions for an account it has
    exists: accountValue > 0n || spotUsdcWei > 0n || szi !== 0n ? 1 : 0,
  };
}

/** Node mode: the hedge account, as this node's own Hyperliquid reads show it. */
export function readHedgeAccount(
  nodeRuntime: NodeRuntime<unknown>,
  hl: HyperliquidConfig,
  gw: GatewayConfig,
): HedgeAccountRead {
  const state = post<Clearinghouse>(nodeRuntime, hl.apiUrl, { type: "clearinghouseState", user: gw.hedgeAccount, dex: hl.dex });
  const spot = post<SpotState>(nodeRuntime, hl.apiUrl, { type: "spotClearinghouseState", user: gw.hedgeAccount });
  const ctxs = post<Ctxs>(nodeRuntime, hl.apiUrl, { type: "metaAndAssetCtxs", dex: hl.dex });
  return toHedgeAccountRead(state, spot, ctxs, hl.coin, gw.szDecimals);
}

/** HyperCoreGateway.Snapshot, as `_processReport` decodes it. The DON never acknowledges orders: executedNonce 0. */
export function encodeSnapshot(r: HedgeAccountRead): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "observedAt", type: "uint64" },
          { name: "szi", type: "int64" },
          { name: "entryNtl", type: "uint64" },
          { name: "accountValue", type: "int64" },
          { name: "marginUsed", type: "uint64" },
          { name: "ntlPos", type: "uint64" },
          { name: "spotUsdcWei", type: "uint64" },
          { name: "oraclePx", type: "uint64" },
          { name: "markPx", type: "uint64" },
          { name: "leverage", type: "uint32" },
          { name: "exists", type: "bool" },
          { name: "executedNonce", type: "uint64" },
        ],
      },
    ],
    [
      {
        observedAt: BigInt(r.observedAt),
        szi: r.szi,
        entryNtl: r.entryNtl,
        accountValue: r.accountValue,
        marginUsed: r.marginUsed,
        ntlPos: r.ntlPos,
        spotUsdcWei: r.spotUsdcWei,
        oraclePx: r.oraclePx,
        markPx: r.markPx,
        leverage: r.leverage,
        exists: r.exists === 1,
        executedNonce: 0n,
      },
    ],
  );
}

export function writeGatewaySnapshot(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  gateway: Address,
  r: HedgeAccountRead,
  gasLimit: string,
) {
  const signed = runtime.report(prepareReportRequest(encodeSnapshot(r))).result();
  return evm.writeReport(runtime, { receiver: gateway, report: signed, gasConfig: { gasLimit } }).result();
}
