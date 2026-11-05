import { readFileSync } from "node:fs";
import { z } from "zod";

import type { Address, Config, DeploymentInfo, Hex } from "./types.js";
import { parseUsdc } from "./units.js";

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
  DEPLOYMENTS_PATH: z.string().min(1).default("/shared/deployments.json"),
  RISK_ENGINE_URL: z.string().min(1).default("http://localhost:8081"),
  RISK_ENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  RISK_ENGINE_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  TICK_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  TX_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(9090),
  DRY_RUN: z.string().optional(),
  KILL_SWITCH: z.string().optional(),
  KILL_SWITCH_FILE: z.string().min(1).default("/shared/KILL"),
  IDLE_RESERVE_USDC: z.string().default("10"),
  CORE_RESERVE_USDC: z.string().default("10"),
  TOPUP_USDC: z.string().default("1000"),
  MAX_ACTIONS_PER_MINUTE: z.coerce.number().int().positive().default(6),
  MAX_CONSECUTIVE_REVERTS: z.coerce.number().int().positive().default(3),
  MIN_SIGNER_BALANCE_WEI: z.string().default("1000000000000000"),
  GAS_LIMIT_CAP: z.coerce.number().int().positive().default(3_000_000),
  GAS_LIMIT_MARGIN_BPS: z.coerce.number().int().min(0).max(10_000).default(2500),
  UNWIND_COOLDOWN_OPEN_SEC: z.string().optional(),
});

const borrowerSchema = z.object({
  address: addressSchema,
  collateral: z.string().regex(/^\d+$/),
  borrowAssets: z.string().regex(/^\d+$/),
  label: z.string().optional(),
});

const deploymentSchema = z.object({
  chainId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  vault: addressSchema,
  morpho: addressSchema,
  marketId: hex32Schema,
  lltv: z.string().regex(/^\d+$/),
  price: z.string().regex(/^\d+$/),
  szDecimals: z.union([z.number().int().min(0).max(18), z.string().regex(/^\d+$/)]),
  orderDelaySec: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]),
  unwindCooldownOpenSec: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]),
  keeperAddress: addressSchema.optional(),
  borrowers: z.array(borrowerSchema),
});

function toBig(value: number | string): bigint {
  return BigInt(value);
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

  let raw: string;
  try {
    raw = readFile(e.DEPLOYMENTS_PATH, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read deployments file ${e.DEPLOYMENTS_PATH}: ${String(error)}`);
  }

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

  const deployment: DeploymentInfo = {
    chainId: toBig(d.chainId),
    vault: d.vault as Address,
    morpho: d.morpho as Address,
    marketId: d.marketId as Hex,
    lltv: BigInt(d.lltv),
    price: BigInt(d.price),
    szDecimals: toBig(d.szDecimals),
    orderDelaySec: toBig(d.orderDelaySec),
    unwindCooldownOpenSec: toBig(d.unwindCooldownOpenSec),
    ...(d.keeperAddress === undefined ? {} : { keeperAddress: d.keeperAddress as Address }),
    borrowers: d.borrowers.map((b) => ({
      address: b.address as Address,
      collateral: BigInt(b.collateral),
      borrowAssets: BigInt(b.borrowAssets),
      ...(b.label === undefined ? {} : { label: b.label }),
    })),
  };

  const checkUsdc = (name: string, value: string): bigint => {
    try {
      return parseUsdc(value);
    } catch (error) {
      throw new ConfigError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const unwindOpen = e.UNWIND_COOLDOWN_OPEN_SEC === undefined
    ? deployment.unwindCooldownOpenSec
    : BigInt(e.UNWIND_COOLDOWN_OPEN_SEC);

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
    deploymentsPath: e.DEPLOYMENTS_PATH,
    keeperPrivateKey: e.KEEPER_PK as Hex,
    deployments: deployment,
    riskEngineUrl: e.RISK_ENGINE_URL,
    riskEngineTimeoutMs: e.RISK_ENGINE_TIMEOUT_MS,
    riskEngineRetries: e.RISK_ENGINE_RETRIES,
    tickMs: e.TICK_MS,
    txTimeoutMs: e.TX_TIMEOUT_MS,
    healthPort: e.HEALTH_PORT,
    dryRun: boolEnv(e.DRY_RUN),
    killSwitchFile: e.KILL_SWITCH_FILE,
    killSwitchEnv: boolEnv(e.KILL_SWITCH),
    idleReserveUsdc: checkUsdc("IDLE_RESERVE_USDC", e.IDLE_RESERVE_USDC),
    coreReserveUsdc: checkUsdc("CORE_RESERVE_USDC", e.CORE_RESERVE_USDC),
    topUpUsdc: checkUsdc("TOPUP_USDC", e.TOPUP_USDC),
    maxActionsPerMinute: e.MAX_ACTIONS_PER_MINUTE,
    maxConsecutiveReverts: e.MAX_CONSECUTIVE_REVERTS,
    minSignerBalanceWei: minBalance,
    gasLimitCap,
    gasLimitMarginBps: BigInt(e.GAS_LIMIT_MARGIN_BPS),
    unwindCooldownOpenSec: unwindOpen,
  };
}
