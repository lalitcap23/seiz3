import { z } from "zod";

/**
 * The keeper's polled-data export contract.
 *
 * Keeper serializes one `PollExport` per tick and serves it on GET /snapshot.
 * A future risk engine (or any other consumer) imports this module to parse
 * that payload with the same schema the keeper uses to build it.
 *
 * All on-chain integers are bigint in-process; on the wire they are decimal
 * strings (the schemas accept either so both sides can share one definition).
 */

export const POLL_EXPORT_SCHEMA_VERSION = 2;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const bigintSchema = z.union([
  z.bigint(),
  z.string().regex(/^-?\d+$/).transform((value) => BigInt(value)),
]);

const pendingHedgeSchema = z.object({
  delta: bigintSchema,
  sentBlock: bigintSchema,
  sentAt: bigintSchema,
  tries: bigintSchema,
});

/** RiskParams.Params */
const riskConfigSchema = z.object({
  maxLiquidation: bigintSchema,
  maxUnhedged: bigintSchema,
  leverage: bigintSchema,
  marginBufferBps: bigintSchema,
  minDiscountBps: bigintSchema,
  oracleBandBps: bigintSchema,
  hedgeCapBps: bigintSchema,
  maxSlippageBps: bigintSchema,
  maxTries: bigintSchema,
  orderDelaySec: bigintSchema,
  cooldownOpenSec: bigintSchema,
  cooldownClosedSec: bigintSchema,
  withdrawReserve: bigintSchema,
  maxImpactBps: bigintSchema,
  transitBlocks: bigintSchema,
});

const marketStateSchema = z.object({
  id: hex32Schema,
  price: bigintSchema,
  lltv: bigintSchema,
});

const borrowerStateSchema = z.object({
  address: addressSchema,
  collateral: bigintSchema,
  borrowAssets: bigintSchema,
});

export const vaultStateSchema = z.object({
  blockNumber: bigintSchema,
  blockTimestamp: bigintSchema,
  vault: addressSchema,
  pendingHedge: pendingHedgeSchema,
  inventory: bigintSchema,
  confirmedShort: bigintSchema,
  pauseFlags: bigintSchema, // 1 hedge stuck, 2 margin low, 4 owner
  lastUnwindAt: bigintSchema,
  idleUsdc: bigintSchema,
  coreUsdc: bigintSchema,
  marginShortfall: bigintSchema,
  marginTarget: bigintSchema,
  marketOpen: z.boolean(),
  risk: riskConfigSchema,
  market: marketStateSchema,
  borrowers: z.array(borrowerStateSchema),
});

export const borrowerReportSchema = z.object({
  address: addressSchema,
  collateral: bigintSchema,
  borrowAssets: bigintSchema,
  lltv: bigintSchema,
  lltvBps: bigintSchema,
  collateralValueUsdc: bigintSchema,
  ltvBps: bigintSchema,
  liquidatable: z.boolean(),
  maxSeizedAssets: bigintSchema,
  label: z.string().optional(),
});

export const scanReportSchema = z.object({
  ts: bigintSchema,
  blockNumber: bigintSchema,
  morpho: addressSchema,
  marketId: hex32Schema,
  price: bigintSchema,
  lltv: bigintSchema,
  borrowers: z.array(borrowerReportSchema),
  liquidatableCount: z.number().int().nonnegative(),
});

export const morphoApiPositionSchema = z.object({
  user: addressSchema,
  marketId: hex32Schema,
  symbol: z.string().nullable(),
  loanSymbol: z.string().nullable(),
  lltv: bigintSchema,
  healthFactor: z.number().nullable(),
  collateral: bigintSchema,
  borrowAssets: bigintSchema,
  collateralUsd: z.number().nullable(),
  borrowAssetsUsd: z.number().nullable(),
});

export const morphoApiSnapshotSchema = z.object({
  fetchedAt: z.number(),
  chainId: bigintSchema,
  marketId: hex32Schema,
  positions: z.array(morphoApiPositionSchema),
});

export const pollExportSchema = z.object({
  schemaVersion: z.literal(POLL_EXPORT_SCHEMA_VERSION),
  ts: bigintSchema,
  chainId: bigintSchema,
  blockNumber: bigintSchema,
  vault: addressSchema,
  morpho: addressSchema,
  marketId: hex32Schema,
  state: vaultStateSchema,
  scan: scanReportSchema,
  morphoApi: morphoApiSnapshotSchema.nullable(),
});

export type PendingHedge = z.infer<typeof pendingHedgeSchema>;
export type RiskConfig = z.infer<typeof riskConfigSchema>;
export type MarketState = z.infer<typeof marketStateSchema>;
export type BorrowerState = z.infer<typeof borrowerStateSchema>;
export type VaultState = z.infer<typeof vaultStateSchema>;
export type BorrowerReport = z.infer<typeof borrowerReportSchema>;
export type ScanReport = z.infer<typeof scanReportSchema>;
export type MorphoApiPosition = z.infer<typeof morphoApiPositionSchema>;
export type MorphoApiSnapshot = z.infer<typeof morphoApiSnapshotSchema>;
export type PollExport = z.infer<typeof pollExportSchema>;

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function serializePollExport(value: PollExport): string {
  return JSON.stringify(value, bigintReplacer);
}

export function parsePollExport(value: unknown): PollExport {
  const parsed = JSON.parse(typeof value === "string" ? value : JSON.stringify(value, bigintReplacer));
  return pollExportSchema.parse(parsed);
}
