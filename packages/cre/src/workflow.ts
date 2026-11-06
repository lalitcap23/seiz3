// Afterbell liquidation workflow for the Chainlink Runtime Environment (CRE).
//
// The keeper's decision loop, expressed as a CRE workflow:
//
//   cron ──► read Morpho position (EVM) ──► read Hyperliquid perp price (HTTP API)
//          ──► risk checks (health, oracle band, size cap)
//          ──► DON-signed report ──► CreKeeperGateway.onReport ──► AfterbellVault.liquidate
//
// The contract stays the final authority (the vault re-checks every rule on-chain); CRE is the
// orchestration layer that connects the chain to the external Hyperliquid market — always open,
// like Afterbell itself.
//
// Offline simulation: `pnpm --filter @afterbell/cre test` runs the full flow against SDK mocks
// (EvmMock + stubbed HTTP) — no keys, no network. See README for the CRE CLI path.

import { cre, getNetwork, TxStatus, type Runtime } from "@chainlink/cre-sdk";
import { z } from "zod";
import type { Address, Hex } from "viem";

import { AfterbellBindings } from "./bindings";
import { assess, type Assessment, type PositionRead } from "./risk";
import { readPerpPriceUsd6 } from "./hyperliquid";

export const configSchema = z.object({
  schedule: z.string(), // cron expression, e.g. "*/30 * * * * *"
  evm: z.object({
    chainSelectorName: z.string().default("hyperliquid-testnet"),
    isTestnet: z.boolean().default(true),
    morpho: z.string(),
    gateway: z.string(),
    marketId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    borrower: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
  hyperliquid: z.object({
    apiUrl: z.string().url(),
    coin: z.string(),
  }),
  risk: z.object({
    oracleBandBps: z.coerce.bigint().default(200n),
    maxSeizedUsdc: z.coerce.bigint().default(5_000_000_000n), // $5k USDC for the demo
  }),
});

export type Config = z.infer<typeof configSchema>;

/** Testability seam: everything the workflow touches, injectable in offline simulations. */
export interface Deps {
  readonly bindings: AfterbellBindings;
  readonly readPerpPrice: (runtime: Runtime<unknown>, cfg: Config["hyperliquid"]) => bigint;
}

export function runAfterbellLiquidation(runtime: Runtime<Config>, deps: Deps): string {
  const cfg = runtime.config;
  const b = deps.bindings;

  // 1 · on-chain state
  const params = b.marketParams(runtime, cfg.evm.marketId as Hex);
  const position: PositionRead = b.position(runtime, cfg.evm.marketId as Hex, cfg.evm.borrower as Address);
  const lendingRaw = b.lendingPriceRaw(runtime, params.oracle);
  const lendingPriceUsd6 = lendingRaw / 10n ** 18n; // DemoOracle: USD × 1e24 → 6-dec USDC

  // 2 · external data: the always-open Hyperliquid market the vault hedges against
  const corePriceUsd6 = deps.readPerpPrice(runtime, cfg.hyperliquid);

  // 3 · decision (mirrors the keeper's risk engine rules)
  const decision: Assessment = assess(lendingPriceUsd6, corePriceUsd6, position, {
    lltv: params.lltv,
    oracleBandBps: cfg.risk.oracleBandBps,
    maxSeizedUsdc: cfg.risk.maxSeizedUsdc,
  });

  if (decision.action === "skip") {
    runtime.log(`Afterbell CRE workflow: skipping — ${decision.reason}`);
    return `Skipped — ${decision.reason}`;
  }

  // 4 · DON-signed write → CreKeeperGateway → AfterbellVault.liquidate
  const write = b.writeLiquidation(runtime, cfg.evm.marketId as Hex, cfg.evm.borrower as Address, decision.seized);
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`liquidation tx failed: ${String(write.txStatus)}`);
  }

  runtime.log(`Afterbell CRE workflow: LIQUIDATED — seized ${decision.seized} (${decision.detail})`);
  return `Executed — seized ${decision.seized} NVDAx wei, ${decision.detail}`;
}

export function onCronTrigger(runtime: Runtime<Config>): string {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.evm.chainSelectorName,
    isTestnet: runtime.config.evm.isTestnet,
  });
  if (!network) {
    throw new Error(`chain not found in CRE registry: ${runtime.config.evm.chainSelectorName}`);
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const bindings = new AfterbellBindings(
    evmClient,
    runtime.config.evm.morpho as Address,
    runtime.config.evm.gateway as Address,
  );
  return runAfterbellLiquidation(runtime, { bindings, readPerpPrice: readPerpPriceUsd6 });
}

export function initWorkflow(config: Config) {
  const cronTrigger = new cre.capabilities.CronCapability();
  return [cre.handler(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger)];
}
