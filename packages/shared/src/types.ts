import { z } from "zod";

/** Frozen at hour 0–1: the shape GET /snapshot and GET /stream return. web builds against fixtures/snapshot.json. */

const bigintString = z.string(); // bigint serialised as decimal string

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
});

export const snapshotSchema = z.object({
  updatedAt: z.number(),
  blockNumber: bigintString,
  markets: z.array(marketSnapshotSchema),
  vault: vaultSnapshotSchema,
  hyperliquid: hyperliquidPanelSchema.nullable(), // null when info API is unreachable (stale badge)
  pool: z.object({ price: z.number(), sqrtPriceX96: bigintString, liquidity: bigintString }),
  marketOpen: z.boolean(),
  activity: z.array(activityEventSchema),
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
