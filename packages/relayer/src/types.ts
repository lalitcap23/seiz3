import type { Address } from "viem";

/** HyperCoreGateway.Order: one vault order, as CoreWriter's limit-order action would carry it. */
export interface GatewayOrder {
  readonly nonce: bigint;
  readonly asset: number;
  readonly isBuy: boolean;
  readonly limitPx: bigint; // wire (human × 1e8)
  readonly sz: bigint; // wire
  readonly reduceOnly: boolean;
  readonly tif: number;
  readonly cloid: bigint;
  readonly requestedAt: bigint;
}

/** HyperCoreGateway.Snapshot without the acknowledgement: the hedge account as HyperCore shows it. */
export interface CoreState {
  readonly observedAt: bigint; // unix seconds, HyperCore's clock
  readonly szi: bigint; // Core size units
  readonly entryNtl: bigint; // USD 6 dec
  readonly accountValue: bigint; // USD 6 dec on the perp DEX
  readonly marginUsed: bigint;
  readonly ntlPos: bigint;
  readonly spotUsdcWei: bigint; // 8 dec
  readonly oraclePx: bigint; // raw perp px: 6 − szDecimals decimals
  readonly markPx: bigint;
  readonly leverage: number;
  readonly exists: boolean;
}

export type PlaceResult =
  | { readonly status: "filled"; readonly size: string; readonly avgPx: string }
  | { readonly status: "partial"; readonly size: string; readonly avgPx: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "duplicate" }; // HyperCore already has this cloid: sent before a restart

/** Where the hedge account lives: Hyperliquid itself, or MockHyperCore on a local anvil. */
export interface HyperCoreBackend {
  readonly name: string;
  readonly account: Address;
  snapshot(): Promise<CoreState>;
  place(order: GatewayOrder): Promise<PlaceResult>;
}
