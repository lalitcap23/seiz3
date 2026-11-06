import { readFileSync } from "node:fs";
import { z } from "zod";

import type { Address, Config, DeploymentInfo, Hex } from "./types.js";
import { parseUsdc } from "./riskCalc.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex string");

const envSchema = z.object({
  RPC_URL: z.string().min(1, "RPC_URL is required"),
  KEEPER_PK: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "KEEPER_PK must be a 32-byte hex key"),
  DEPLOYMENTS_PATH: z.string().min(1).optional(),
  VAULT: addressSchema.optional(),
  MORPHO: addressSchema.optional(),
  MARKET_ID: hex32Schema.optional(),
  CHAIN_ID: z.coerce.number().int().positive().optional(),
  RISK_ENGINE_URL: z.string().min(1).default("http://localhost:8081"),
  RISK_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  RISK_ENGINE_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  MORPHO_API_ENABLED: z.string().optional(),
  MORPHO_API_URL: z.string().min(1).default("https://blue-api.morpho.org/graphql"),
  MORPHO_API_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MORPHO_API_INTERVAL_MS: z.coerce.number().int().min(1000).default(5_000),
  MORPHO_API_MAX_POSITIONS: z.coerce.number().int().min(1).max(500).default(100),
  BORROWER_SCAN_FROM_BLOCK: z.coerce.bigint().optional(), // default: deployments startBlock, else head − 10k
  BORROWER_SCAN_PAGE_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(500),
  BORROWER_SCAN_PAGES_PER_TICK: z.coerce.number().int().min(1).max(100).default(2),
  BORROWER_SCAN_INTERVAL_MS: z.coerce.number().int().min(0).default(4000), // keeps a public logs RPC under its limit
  // eth_getLogs only; default RPC_URL. Alchemy's HyperEVM testnet has no eth_getLogs, so there it's the public RPC.
  LOGS_RPC_URL: z.string().min(1).optional(),
  WATCH_FILE: z.string().min(1).optional(), // default watch.json next to DEPLOYMENTS_PATH (the API writes it)
  // buy-back liquidity gate (liquidityGate.ts): unset HL_INFO_API_URL turns it off (local MockHyperCore fills all)
  HL_INFO_API_URL: z.string().url().optional(),
  HL_COIN: z.string().min(1).default("xyz:NVDA"),
  ASK_REQUEST_FILE: z.string().min(1).optional(), // default ASK_REQUEST.json next to DEPLOYMENTS_PATH (bots read it)
  UNWIND_CHUNK_ESTIMATE_UNITS: z.coerce.bigint().default(100n), // Core size units an unwind chunk counts as at most
  TICK_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  TX_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(9090),
  DRY_RUN: z.string().optional(),
  KILL_SWITCH: z.string().optional(),
  KILL_SWITCH_FILE: z.string().min(1).default("/shared/KILL"),
  IDLE_RESERVE_USDC: z.string().default("10"),
  CORE_RESERVE_USDC: z.string().default("10"),
  MAX_ACTIONS_PER_MINUTE: z.coerce.number().int().positive().default(6),
  MAX_CONSECUTIVE_REVERTS: z.coerce.number().int().positive().default(3),
  MIN_SIGNER_BALANCE_WEI: z.string().default("1000000000000000"),
  GAS_LIMIT_CAP: z.coerce.number().int().positive().default(3_000_000),
  GAS_LIMIT_MARGIN_BPS: z.coerce.number().int().min(0).max(10_000).default(2500),
});

const borrowerSchema = z.object({
  address: addressSchema,
  label: z.string().optional(),
});

/**
 * deployments/<network>.json as Deploy.s.sol writes it and CreateMarkets.s.sol extends it. Only the
 * fields the keeper needs are checked; everything else (pool key, HyperCore ids, ...) is ignored.
 */
const deploymentSchema = z.object({
  chainId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  vault: addressSchema,
  morpho: addressSchema,
  markets: z.object({ C_afterbell: z.object({ id: hex32Schema }) }),
  borrowers: z.array(borrowerSchema).default([]),
  /** Block the markets were created in: where borrower discovery starts. */
  startBlock: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  hypercore: z.object({ szDecimals: z.number().int().min(0).max(6), perpAsset: z.number().int().positive() }).optional(),
});

function toBig(value: number | string): bigint {
  return BigInt(value);
}

function parseDeploymentsJson(raw: string): DeploymentInfo {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigError(`deployments file is not valid JSON: ${String(error)}`);
  }

  const parsed = deploymentSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues
        .map((issue) => `deployments.${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }
  const d = parsed.data;

  return {
    chainId: toBig(d.chainId),
    vault: d.vault as Address,
    morpho: d.morpho as Address,
    marketId: d.markets.C_afterbell.id as Hex,
    borrowers: d.borrowers.map((b) => ({
      address: b.address as Address,
      ...(b.label === undefined ? {} : { label: b.label }),
    })),
    ...(d.startBlock === undefined ? {} : { startBlock: toBig(d.startBlock) }),
    ...(d.hypercore === undefined ? {} : { szDecimals: d.hypercore.szDecimals, perpAsset: d.hypercore.perpAsset }),
  };
}

function envDeployment(e: z.infer<typeof envSchema>): DeploymentInfo {
  if (e.VAULT === undefined || e.MORPHO === undefined) {
    throw new ConfigError(
      "no deployment config: set DEPLOYMENTS_PATH, or set VAULT and MORPHO (plus optional CHAIN_ID, MARKET_ID)",
    );
  }
  const chainId = BigInt(e.CHAIN_ID ?? 31337);
  return {
    chainId,
    vault: e.VAULT as Address,
    morpho: e.MORPHO as Address,
    marketId: (e.MARKET_ID ?? `0x${"0".repeat(64)}`) as Hex,
    borrowers: [],
  };
}

function resolveDeployment(
  e: z.infer<typeof envSchema>,
  readFile: (path: string, encoding: "utf8") => string,
): DeploymentInfo {
  const envProvided =
    e.VAULT !== undefined ||
    e.MORPHO !== undefined ||
    e.MARKET_ID !== undefined ||
    e.CHAIN_ID !== undefined;

  if (e.DEPLOYMENTS_PATH === undefined) {
    if (!envProvided) {
      throw new ConfigError(
        "no deployment config: set DEPLOYMENTS_PATH, or set VAULT and MORPHO (plus optional CHAIN_ID, MARKET_ID)",
      );
    }
    return envDeployment(e);
  }

  let raw: string;
  try {
    raw = readFile(e.DEPLOYMENTS_PATH, "utf8");
  } catch (error) {
    if (!envProvided) {
      throw new ConfigError(`cannot read deployments file ${e.DEPLOYMENTS_PATH}: ${String(error)}`);
    }
    return envDeployment(e);
  }
  return parseDeploymentsJson(raw);
}

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
): Config {
  const parsedEnv = envSchema.safeParse(env);
  if (!parsedEnv.success) {
    throw new ConfigError(
      parsedEnv.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; "),
    );
  }
  const e = parsedEnv.data;

  const deployment = resolveDeployment(e, readFile);

  const checkUsdc = (name: string, value: string): bigint => {
    try {
      return parseUsdc(value);
    } catch (error) {
      throw new ConfigError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const gasLimitCap = BigInt(e.GAS_LIMIT_CAP);
  if (gasLimitCap <= 0n || gasLimitCap > 30_000_000n) {
    throw new ConfigError("GAS_LIMIT_CAP must be between 1 and 30,000,000");
  }

  const minBalance = BigInt(e.MIN_SIGNER_BALANCE_WEI);
  if (minBalance < 0n) throw new ConfigError("MIN_SIGNER_BALANCE_WEI must be >= 0");

  return {
    rpcUrl: e.RPC_URL,
    chainId: deployment.chainId,
    vault: deployment.vault,
    morpho: deployment.morpho,
    deploymentsPath: e.DEPLOYMENTS_PATH ?? "",
    keeperPrivateKey: e.KEEPER_PK as Hex,
    deployments: deployment,
    riskEngineUrl: e.RISK_ENGINE_URL,
    riskEngineTimeoutMs: e.RISK_ENGINE_TIMEOUT_MS,
    riskEngineRetries: e.RISK_ENGINE_RETRIES,
    morphoApiEnabled:
      e.MORPHO_API_ENABLED === undefined
        ? deployment.chainId !== 31337n
        : boolEnv(e.MORPHO_API_ENABLED),
    morphoApiUrl: e.MORPHO_API_URL,
    morphoApiTimeoutMs: e.MORPHO_API_TIMEOUT_MS,
    morphoApiIntervalMs: e.MORPHO_API_INTERVAL_MS,
    morphoApiMaxPositions: e.MORPHO_API_MAX_POSITIONS,
    borrowerScanFromBlock: e.BORROWER_SCAN_FROM_BLOCK ?? deployment.startBlock ?? null,
    borrowerScanPageBlocks: BigInt(e.BORROWER_SCAN_PAGE_BLOCKS),
    borrowerScanPagesPerTick: e.BORROWER_SCAN_PAGES_PER_TICK,
    borrowerScanIntervalMs: e.BORROWER_SCAN_INTERVAL_MS,
    logsRpcUrl: e.LOGS_RPC_URL ?? e.RPC_URL,
    hlInfoUrl: e.HL_INFO_API_URL ?? null,
    hlCoin: e.HL_COIN,
    askRequestFile:
      e.ASK_REQUEST_FILE ?? (e.DEPLOYMENTS_PATH ? `${e.DEPLOYMENTS_PATH.replace(/[^/]*$/, "")}ASK_REQUEST.json` : null),
    unwindChunkEstimateUnits: e.UNWIND_CHUNK_ESTIMATE_UNITS,
    watchFile:
      e.WATCH_FILE ?? (e.DEPLOYMENTS_PATH ? `${e.DEPLOYMENTS_PATH.replace(/[^/]*$/, "")}watch.json` : null),
    tickMs: e.TICK_MS,
    txTimeoutMs: e.TX_TIMEOUT_MS,
    healthPort: e.HEALTH_PORT,
    dryRun: boolEnv(e.DRY_RUN),
    killSwitchFile: e.KILL_SWITCH_FILE,
    killSwitchEnv: boolEnv(e.KILL_SWITCH),
    idleReserveUsdc: checkUsdc("IDLE_RESERVE_USDC", e.IDLE_RESERVE_USDC),
    coreReserveUsdc: checkUsdc("CORE_RESERVE_USDC", e.CORE_RESERVE_USDC),
    maxActionsPerMinute: e.MAX_ACTIONS_PER_MINUTE,
    maxConsecutiveReverts: e.MAX_CONSECUTIVE_REVERTS,
    minSignerBalanceWei: minBalance,
    gasLimitCap,
    gasLimitMarginBps: BigInt(e.GAS_LIMIT_MARGIN_BPS),
  };
}
