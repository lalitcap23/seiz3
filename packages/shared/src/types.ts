import { z } from "zod";

/** Frozen at hour 0–1: the shape GET /snapshot and GET /stream return. web builds against fixtures/snapshot.json. */

const bigintString = z.string(); // bigint serialised as decimal string

/** One open (or just liquidated) Morpho position, debt with the interest Morpho hasn't booked yet. */
export const borrowerRowSchema = z.object({
  address: z.string(),
  debt: bigintString, // USDC 6 dec
  collateral: bigintString, // NVDAx 18 dec
  collateralValue: bigintString, // USDC 6 dec at the market's oracle
  ltv: z.number(),
  healthy: z.boolean(),
});

/** A Morpho `Liquidate` on this market, and who did it. */
export const marketLiquidationSchema = z.object({
  txHash: z.string(),
  blockNumber: bigintString,
  timestamp: z.number(),
  borrower: z.string(),
  repaid: bigintString,
  seized: bigintString,
  badDebt: bigintString,
  by: z.enum(["vault", "naive", "other"]),
  opId: z.string().nullable(), // LIQ-n when the vault took it
});

export const marketSnapshotSchema = z.object({
  name: z.enum(["A_naive", "B_conservative", "C_afterbell"]),
  lltv: z.number(), // 0.77
  totalBorrow: bigintString, // USDC 6 dec
  totalCollateral: bigintString, // NVDAx 18 dec
  borrower: z.object({
    address: z.string(),
    debt: bigintString,
    collateral: bigintString,
    ltv: z.number(),
    healthy: z.boolean(),
  }),
  badDebt: bigintString,
  oraclePrice: z.number(), // USD per NVDAx
  /** Every known borrower (deployments, /try and faucet testers, Borrow events), riskiest first. */
  borrowers: z.array(borrowerRowSchema).default([]),
  liquidations: z.array(marketLiquidationSchema).default([]),
});

export const hedgeStateSchema = z.enum(["Idle", "Pending", "Retrying", "Paused"]);

export const vaultSnapshotSchema = z.object({
  address: z.string(),
  inventory: bigintString,
  confirmedShort: bigintString, // signed Core size units
  szDecimals: z.number(), // Core size units per NVDA: confirmedShort and the hedge events' sizes are 10^-szDecimals
  pendingHedge: z.object({
    delta: bigintString,
    sentBlock: bigintString,
    sentAt: z.number(),
    tries: z.number(),
  }),
  hedgeState: hedgeStateSchema,
  hedgeRatio: z.number(), // |short| / inventory, 0..1+
  paused: z.boolean(),
  totalAssets: bigintString,
  totalSupply: bigintString,
  sharePrice: z.number(),
  marginFloat: bigintString,
});

export const hyperliquidPanelSchema = z.object({
  coin: z.string(), // "xyz:NVDA"
  size: z.number(),
  entryPx: z.number().nullable(),
  unrealizedPnl: z.number(),
  marginUsed: z.number(),
  accountValue: z.number(),
  markPx: z.number(),
  oraclePx: z.number(),
  explorerUrl: z.string(),
});

export const activityEventSchema = z.object({
  type: z.enum([
    "LiquidationTaken",
    "HedgeSent",
    "HedgeConfirmed",
    "HedgeStuck",
    "Unwound",
    "MarginMoved",
  ]),
  txHash: z.string(),
  blockNumber: bigintString,
  timestamp: z.number(),
  cloid: z.string().optional(),
  args: z.record(z.string(), z.unknown()),
  /** The liquidation or unwind (LIQ-n / UNW-n) this event belongs to. */
  opId: z.string().optional(),
});

/** One vault order on HyperCore and what it filled (from Hyperliquid's fills, matched by cloid). */
export const hedgeOrderSchema = z.object({
  txHash: z.string(),
  cloid: z.string(),
  delta: bigintString, // signed Core size units: < 0 short, > 0 buy-back
  tries: z.number(),
  limitPx: z.number(),
  filled: z.number(), // NVDA
  avgPx: z.number().nullable(),
  fills: z.array(z.object({ sz: z.string(), px: z.string(), hash: z.string(), time: z.number() })),
});

/**
 * A liquidation or an unwind, end to end. The vault has one hedge in flight at a time, so every order, retry and
 * confirmation after it belongs to it until it's confirmed. Unwinds sell the stock first in, first out: `lots` says
 * whose stock each unwind sold and how much of each liquidation is still held.
 */
export const operationSchema = z.object({
  id: z.string(), // LIQ-n, UNW-n; LIQ-0 is stock held before the feed starts
  kind: z.enum(["liquidation", "unwind"]),
  txHash: z.string(),
  blockNumber: bigintString,
  timestamp: z.number(),
  borrower: z.string().nullable(),
  market: z.string().nullable(),
  nvdax: bigintString, // seized (liquidation) or sold (unwind), 18 dec
  usdc: bigintString, // repaid to Morpho (liquidation) or received from the pool (unwind), 6 dec
  orders: z.array(hedgeOrderSchema),
  confirmed: z.object({ txHash: z.string(), timestamp: z.number(), actual: bigintString }).nullable(),
  /** liquidation: unwound by UNW-n; unwind: sold from LIQ-n. NVDAx 18 dec. */
  lots: z.array(z.object({ opId: z.string(), nvdax: bigintString })),
  held: bigintString, // liquidation: NVDAx of it still in the vault
});

export const snapshotSchema = z.object({
  updatedAt: z.number(),
  blockNumber: bigintString,
  markets: z.array(marketSnapshotSchema),
  vault: vaultSnapshotSchema,
  hyperliquid: hyperliquidPanelSchema.nullable(), // null when info API is unreachable (stale badge)
  pool: z.object({ price: z.number(), sqrtPriceX96: bigintString, liquidity: bigintString }),
  /** Market A's own weekend pool on testnet; absent where A dumps into the vault's pool (local). */
  thinPool: z.object({ price: z.number(), sqrtPriceX96: bigintString, liquidity: bigintString }).optional(),
  marketOpen: z.boolean(),
  activity: z.array(activityEventSchema),
  operations: z.array(operationSchema).default([]),
});

export const historyPointSchema = z.object({
  t: z.number(),
  inventory: z.number(),
  short: z.number(),
  hedgeRatio: z.number(),
  sharePrice: z.number(),
});

export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;
export type HedgeState = z.infer<typeof hedgeStateSchema>;
export type VaultSnapshot = z.infer<typeof vaultSnapshotSchema>;
export type HyperliquidPanel = z.infer<typeof hyperliquidPanelSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type HistoryPoint = z.infer<typeof historyPointSchema>;
export type BorrowerRow = z.infer<typeof borrowerRowSchema>;
export type MarketLiquidation = z.infer<typeof marketLiquidationSchema>;
export type HedgeOrder = z.infer<typeof hedgeOrderSchema>;
export type Operation = z.infer<typeof operationSchema>;
