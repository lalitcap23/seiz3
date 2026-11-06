import {
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  parseAbiParameters,
  type PublicClient,
} from "viem";

import { Breaker } from "./breaker.js";
import { BorrowerScan } from "./borrowerScan.js";
import { makeClients } from "./clients.js";
import { loadConfig } from "./config.js";
import { executeAction, verifyEffect } from "./executor.js";
import { buildPollExport, serializePollExport } from "./export.js";
import {
  Logger,
  Metrics,
  Telemetry,
  killSwitchActive,
  stateSnapshot,
  type RiskEngineStatus,
} from "./observe.js";
import { MorphoApiClient, morphoApiLiquidatable, morphoApiLtvBps, type MorphoApiSnapshot } from "./morphoApi.js";
import {
  RiskEngineClient,
  buildRiskRequest,
  describeError,
} from "./riskEngine.js";
import { readState } from "./state.js";
import { readWatchlist } from "./watchlist.js";
import { buyNeeded, checkBuyLiquidity, keepStandingAsk } from "./liquidityGate.js";
import { StartupError, runStartup } from "./startup.js";
import type { Action, Address, Config, RiskDecision, ScanReport, VaultState } from "./types.js";

const logger = new Logger();
const metrics = new Metrics();

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (error) {
    logger.error({ event: "config-invalid", error: describeError(error) });
    process.exitCode = 1;
    return;
  }

  const clients = makeClients(cfg);
  const telemetry = new Telemetry(metrics);
  const breaker = new Breaker(cfg);
  const riskEngine = new RiskEngineClient(cfg);
  const morphoApi = cfg.morphoApiEnabled ? new MorphoApiClient(cfg) : null;
  let morphoApiSnapshot: MorphoApiSnapshot | null = null;
  let morphoApiNextRefreshMs = 0;
  const logsClient =
    cfg.logsRpcUrl === cfg.rpcUrl
      ? clients.publicClient
      : (createPublicClient({ chain: clients.chain, transport: http(cfg.logsRpcUrl, { retryCount: 1, timeout: 15_000 }) }) as PublicClient);
  let nextScanAtMs = 0;
  const borrowerScan = new BorrowerScan(logsClient, {
    morpho: cfg.morpho,
    marketId: cfg.deployments.marketId,
    fromBlock: cfg.borrowerScanFromBlock,
    pageBlocks: cfg.borrowerScanPageBlocks,
    maxPagesPerPoll: cfg.borrowerScanPagesPerTick,
  });
  let scannedBorrowers: readonly Address[] = [];
  const riskStatus: {
    url: string;
    lastOkAtMs: number | null;
    lastError: string | null;
    lastLatencyMs: number | null;
  } = {
    url: cfg.riskEngineUrl,
    lastOkAtMs: null,
    lastError: null,
    lastLatencyMs: null,
  };

  try {
    const report = await runStartup(cfg, clients, (check) =>
      logger.line({ event: "startup-check", ...check }),
    );
    logger.line({
      event: "startup-ok",
      checks: report.checks.length,
      vault: cfg.vault,
      morpho: cfg.morpho,
      signer: clients.account.address,
      chainId: cfg.chainId,
      dryRun: cfg.dryRun,
      riskEngine: cfg.riskEngineUrl,
      morphoApi: cfg.morphoApiEnabled ? cfg.morphoApiUrl : "disabled",
      morphoApiIntervalMs: cfg.morphoApiEnabled ? cfg.morphoApiIntervalMs : 0,
    });
  } catch (error) {
    if (error instanceof StartupError) {
      logger.error({ event: "startup-failed", checks: error.checks });
    } else {
      logger.error({ event: "startup-failed", error: describeError(error) });
    }
    process.exitCode = 1;
    return;
  }

  telemetry.startHealthServer({
    breaker: () => breaker.snapshot(Date.now()),
    riskEngine: () => riskStatus as RiskEngineStatus,
    killSwitch: () => killSwitchActive(cfg),
    cfg,
  });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastBlock = -1n;

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    logger.line({ event: "shutdown", signal });
    await telemetry.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick();
    } catch (error) {
      metrics.inc("afterbell_keeper_tick_errors_total");
      logger.error({ event: "tick-error", error: describeError(error) });
    } finally {
      if (!stopped) timer = setTimeout(() => void loop(), cfg.tickMs);
    }
  };

  async function tick(): Promise<void> {
    metrics.inc("afterbell_keeper_ticks_total");
    const nowMs = Date.now();
    if (killSwitchActive(cfg)) {
      telemetry.tick(null);
      telemetry.decision(null, "kill-switch");
      logDecision(null, null, null, "kill-switch", null, undefined);
      return;
    }

    if (breaker.isOpen()) {
      telemetry.tick(null);
      telemetry.decision(null, "breaker-open");
      logDecision(null, null, null, "breaker-open", null, undefined);
      return;
    }

    const apiBorrowers = await morphoApiBorrowers(nowMs);
    const watched = readWatchlist(cfg.watchFile);
    const { state, scan } = await readState(clients.publicClient, cfg, [...watched, ...apiBorrowers, ...scannedBorrowers]);
    await scanBorrowers(state);
    // The chain went back (an anvil revert between demo runs, or a reorg): the cached nonce is from the abandoned
    // branch, and a transaction sent with it would sit in the queue until the receipt times out.
    if (state.blockNumber < lastBlock) {
      clients.nonces.reset();
      logger.line({ event: "chain-rewound", from: lastBlock, to: state.blockNumber });
    }
    lastBlock = state.blockNumber;
    // buyers can take stock through the pool's hook at any moment, and that buy-back can't wait for an ask
    if (cfg.deployments.hook && cfg.hlInfoUrl !== null) {
      keepStandingAsk(cfg.askRequestFile, state, cfg.deployments.szDecimals ?? 3, nowMs);
    }
    // The vault times orders with block.timestamp, so the keeper decides on the same clock.
    const now = state.blockTimestamp;
    telemetry.tick(state.blockNumber, state);
    logScan(scan);
    telemetry.setSnapshot(serializePollExport(buildPollExport(state, scan, morphoApiSnapshot, cfg)));

    const request = buildRiskRequest(state, scan, now, cfg);
    metrics.inc("afterbell_keeper_risk_engine_requests_total");
    const result = await riskEngine.decide(request);

    if (!result.ok) {
      riskStatus.lastError = result.error;
      metrics.inc("afterbell_keeper_risk_engine_errors_total");
      telemetry.decision(null, "risk-engine-error");
      logDecision(state, scan, null, "risk-engine-error", null, {
        error: result.error,
        retriable: result.retriable,
        attempts: result.attempts,
      });
      return;
    }

    riskStatus.lastOkAtMs = Date.now();
    riskStatus.lastError = null;
    riskStatus.lastLatencyMs = result.latencyMs;
    metrics.inc("afterbell_keeper_risk_engine_ok_total");
    const decision: RiskDecision = result.decision;

    if (decision.action === null) {
      telemetry.decision(null, decision.reason);
      logDecision(state, scan, null, decision.reason, null, {
        latencyMs: result.latencyMs,
        attempts: result.attempts,
        engineVersion: decision.engineVersion,
        confidenceBps: decision.confidenceBps,
        role: result.role,
        leaderId: result.leaderId,
      });
      return;
    }

    const permit = breaker.canSend(nowMs);
    if (!permit.ok) {
      telemetry.decision(decision.action.kind, permit.reason ?? "rate-limit");
      logDecision(state, scan, decision, permit.reason ?? "rate-limit", null, {
        latencyMs: result.latencyMs,
        engineVersion: decision.engineVersion,
        confidenceBps: decision.confidenceBps,
      });
      return;
    }

    // a buy-back with no ask to fill it is rejected on HyperCore, after the unwind has already sold the stock
    const coreSzi =
      decision.action.kind === "syncHedge" && state.pendingHedge.delta > 0n ? await readCoreSzi() : null;
    const need = buyNeeded(decision.action, state, cfg.deployments.szDecimals ?? 3, cfg.unwindChunkEstimateUnits, coreSzi);
    if (need > 0n) {
      const gate = await checkBuyLiquidity(
        { hlInfoUrl: cfg.hlInfoUrl, coin: cfg.hlCoin, requestFile: cfg.askRequestFile },
        need,
        cfg.deployments.szDecimals ?? 3,
        state.risk.hedgeCapBps,
      ).catch((error: unknown) => ({ ok: false as const, reason: `book-unreadable: ${describeError(error)}`, needNvda: 0 }));
      if (!gate.ok) {
        telemetry.decision(decision.action.kind, gate.reason);
        logDecision(state, scan, decision, gate.reason, null, { needNvda: gate.needNvda });
        return;
      }
    }

    breaker.recordAction(nowMs);
    const execution = await executeAction({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      account: clients.account,
      nonces: clients.nonces,
      cfg,
      action: decision.action,
      state,
      now,
    });

    switch (execution.status) {
      case "skipped": {
        metrics.inc("afterbell_keeper_actions_skipped_total", { reason: execution.reason });
        telemetry.decision(decision.action.kind, execution.reason);
        logDecision(state, scan, decision, execution.reason, null, {
          latencyMs: result.latencyMs,
          engineVersion: decision.engineVersion,
          confidenceBps: decision.confidenceBps,
        });
        return;
      }
      case "simulation-reverted": {
        // Nothing was sent: the contract's own checks said no (pool out of band, low Core margin, ...).
        // The spec says skip, so this doesn't count toward the breaker.
        metrics.inc("afterbell_keeper_simulation_reverts_total", { action: decision.action.kind });
        telemetry.decision(decision.action.kind, "simulation-reverted");
        logDecision(state, scan, decision, "simulation-reverted", null, {
          reason: execution.reason,
          latencyMs: result.latencyMs,
          engineVersion: decision.engineVersion,
          confidenceBps: decision.confidenceBps,
        });
        return;
      }
      case "dry-run": {
        metrics.inc("afterbell_keeper_dry_runs_total", { action: decision.action.kind });
        telemetry.decision(decision.action.kind, "dry-run");
        logDecision(state, scan, decision, "dry-run", null, {
          gas: execution.gas,
          dryRun: true,
          latencyMs: result.latencyMs,
        });
        return;
      }
      case "sent": {
        metrics.inc("afterbell_keeper_sends_total", { action: decision.action.kind });
        metrics.inc("afterbell_keeper_receipts_ok_total");
        const verdict = await verifySentAction(state, decision.action);
        if (!verdict.ok) {
          breaker.recordFailure(nowMs);
          metrics.inc("afterbell_keeper_verify_failed_total", { action: decision.action.kind });
          telemetry.decision(decision.action.kind, "verify-failed");
          logDecision(state, scan, decision, "verify-failed", execution.hash, {
            gas: execution.gas,
            blockNumber: execution.blockNumber,
            latencyMs: result.latencyMs,
            engineVersion: decision.engineVersion,
            confidenceBps: decision.confidenceBps,
            verification: verdict.detail,
          });
          return;
        }
        breaker.recordSuccess();
        telemetry.decision(decision.action.kind, "sent");
        logDecision(state, scan, decision, "sent", execution.hash, {
          gas: execution.gas,
          blockNumber: execution.blockNumber,
          latencyMs: result.latencyMs,
          engineVersion: decision.engineVersion,
          confidenceBps: decision.confidenceBps,
          verification: verdict.detail,
        });
        return;
      }
      default: {
        breaker.recordFailure(nowMs);
        metrics.inc("afterbell_keeper_failures_total", { status: execution.status });
        telemetry.decision(decision.action.kind, execution.status);
        const failureReason = "reason" in execution ? execution.reason : execution.status;
        logDecision(state, scan, decision, execution.status, "hash" in execution ? execution.hash : null, {
          reason: failureReason,
          latencyMs: result.latencyMs,
          engineVersion: decision.engineVersion,
          confidenceBps: decision.confidenceBps,
        });
      }
    }
  }

  /** The vault's position on HyperCore (position2 precompile), or null when there's no HyperCore to read. */
  async function readCoreSzi(): Promise<bigint | null> {
    const asset = cfg.deployments.perpAsset;
    if (asset === undefined) return null;
    try {
      const { data } = await clients.publicClient.call({
        to: "0x0000000000000000000000000000000000000813",
        data: encodeAbiParameters(parseAbiParameters("address, uint32"), [cfg.vault, asset >= 100_000 ? asset - 100_000 : asset]),
      });
      const [szi] = decodeAbiParameters(parseAbiParameters("int64, uint64, int64, uint32, bool"), data ?? "0x");
      return szi;
    } catch {
      return null; // unknown: the gate treats the whole pending buy as needed
    }
  }

  /** Borrowers found this tick are read from the next one on. A failed scan keeps the list it had. */
  async function scanBorrowers(state: VaultState): Promise<void> {
    borrowerScan.prune(state.borrowers);
    if (Date.now() < nextScanAtMs) return;
    nextScanAtMs = Date.now() + cfg.borrowerScanIntervalMs;
    try {
      // the logs RPC can sit a block behind the main one, and refuses a range past its own head
      scannedBorrowers = await borrowerScan.poll(state.blockNumber - 2n);
      metrics.set("afterbell_keeper_scanned_borrowers", scannedBorrowers.length);
      metrics.set("afterbell_keeper_borrower_scan_behind_blocks", Number(borrowerScan.behind(state.blockNumber)));
    } catch (error) {
      metrics.inc("afterbell_keeper_borrower_scan_errors_total");
      logger.error({ event: "borrower-scan-error", error: describeError(error) });
    }
  }

  async function morphoApiBorrowers(nowMs: number): Promise<readonly Address[]> {
    if (morphoApi === null) return [];
    if (morphoApiSnapshot === null || nowMs >= morphoApiNextRefreshMs) {
      morphoApiNextRefreshMs = nowMs + cfg.morphoApiIntervalMs;
      try {
        morphoApiSnapshot = await morphoApi.fetchPositions(
          cfg.deployments.marketId,
          cfg.chainId,
        );
        metrics.set("afterbell_morpho_api_positions", morphoApiSnapshot.positions.length, {
          market: cfg.deployments.marketId,
        });
        logMorphoApi(morphoApiSnapshot);
      } catch (error) {
        metrics.inc("afterbell_morpho_api_errors_total");
        logger.error({ event: "morpho-api-error", error: describeError(error) });
      }
    }
    if (morphoApiSnapshot === null) return [];
    return morphoApiSnapshot.positions.slice(0, 50).map((position) => position.user);
  }

  function logMorphoApi(snapshot: MorphoApiSnapshot): void {
    const positions = snapshot.positions
      .filter((position) => position.borrowAssets > 0n)
      .map((position) => ({
        user: position.user,
        symbol: position.symbol,
        loanSymbol: position.loanSymbol,
        healthFactor: position.healthFactor,
        liquidatable: morphoApiLiquidatable(position),
        lltv: position.lltv,
        lltvBps: Number(position.lltv / 10n ** 14n),
        collateral: position.collateral,
        borrowAssets: position.borrowAssets,
        collateralUsd: position.collateralUsd,
        borrowAssetsUsd: position.borrowAssetsUsd,
        ltvBps: morphoApiLtvBps(position),
      }));
    logger.line({
      event: "morpho-api-positions",
      chainId: snapshot.chainId,
      marketId: snapshot.marketId,
      fetchedAt: snapshot.fetchedAt,
      count: positions.length,
      liquidatableCount: positions.filter((position) => position.liquidatable).length,
      positions,
    });
  }

  async function verifySentAction(
    before: VaultState,
    action: Action,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const after = await readState(clients.publicClient, cfg);
      return verifyEffect(before, after.state, action);
    } catch (error) {
      return { ok: false, detail: `state re-read failed: ${describeError(error)}` };
    }
  }

  function logScan(scan: ScanReport): void {
    logger.line({
      event: "morpho-rwa-scan",
      block: scan.blockNumber,
      morpho: scan.morpho,
      marketId: scan.marketId,
      price: scan.price,
      lltv: scan.lltv,
      liquidatableCount: scan.liquidatableCount,
      borrowers: scan.borrowers,
    });
  }

  function logDecision(
    state: VaultState | null,
    scan: ScanReport | null,
    decision: RiskDecision | null,
    reason: string,
    txHash: `0x${string}` | null,
    extra: Record<string, unknown> | undefined,
  ): void {
    const action = decision?.action ?? null;
    logger.decision({
      event: "decision",
      block: state?.blockNumber ?? null,
      action: action === null ? null : action.kind,
      actionParams: action,
      reason,
      stateSnapshot: state === null ? null : stateSnapshot(state),
      scan: scan === null ? null : {
        liquidatableCount: scan.liquidatableCount,
        borrowers: scan.borrowers,
      },
      txHash,
      ...(extra === undefined ? {} : { riskEngine: extra }),
    });
  }

  logger.line({
    event: "keeper-start",
    tickMs: cfg.tickMs,
    dryRun: cfg.dryRun,
    healthPort: cfg.healthPort,
  });
  await loop();
}

void main();
