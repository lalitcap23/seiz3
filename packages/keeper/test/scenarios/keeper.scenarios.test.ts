/**
 * The keeper against the real contracts on a local anvil: real Morpho Blue and Uniswap v4 bytecode, the
 * Seiz3Vault the deploy scripts put there, and MockHyperCore copied over the HyperCore precompiles.
 *
 *   anvil
 *   scripts/local-stack.sh up
 *   pnpm --filter @seiz3/keeper risk-engine:stub
 *   pnpm --filter @seiz3/keeper test:scenarios
 *
 * Don't run `local-stack.sh tick` alongside: HyperCore moves only when a test calls `coreProcess()`.
 * Every test starts from the same anvil snapshot.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { demoOracleAbi, riskParamsAbi } from "@seiz3/shared/abis";
import { beforeEach, describe, expect, it } from "vitest";

import { makeChain, makeClients, SingleNonceManager } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { executeAction, verifyEffect, type ExecuteResult } from "../../src/executor.js";
import { PAUSE_HEDGE } from "../../src/riskCalc.js";
import { RiskEngineClient, buildRiskRequest } from "../../src/riskEngine.js";
import { readState } from "../../src/state.js";
import type { Action, ActionKind, Config, RiskDecision, ScanReport, VaultState } from "../../src/types.js";

const root = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(root(path), "utf8")) as Record<string, unknown>;

// anvil's default accounts, as scripts/local-stack.sh uses them
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TICKER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const cfg = loadConfig({
  RPC_URL: "http://127.0.0.1:8545",
  KEEPER_PK,
  DEPLOYMENTS_PATH: root("deployments/local.json"),
  RISK_ENGINE_URL: "http://127.0.0.1:8081",
  ...process.env,
});
const keeper = makeClients(cfg);
const riskEngine = new RiskEngineClient(cfg);
const chain = makeChain(cfg);
const transport = http(cfg.rpcUrl);
const admin = createWalletClient({ account: privateKeyToAccount(DEPLOYER_PK), chain, transport });
const ticker = createWalletClient({ account: privateKeyToAccount(TICKER_PK), chain, transport });
const anvil = createTestClient({ mode: "anvil", chain, transport });

const deployment = json("deployments/local.json") as {
  riskParams: Address;
  markets: { C_seiz3: { oracle: Address } };
  borrowers: { address: Address }[];
};
const core = (json("deployments/local-chain.json") as { core: Address }).core;
// The mock's test knobs, straight from forge's build output.
const coreAbi = (json("contracts/out/MockHyperCore.sol/MockHyperCore.json") as { abi: Abi }).abi;
const borrower = deployment.borrowers[0]?.address as Address;

const NVDAX = 10n ** 18n;
const START_USD6 = 217_000000n;
const DROP_USD6 = 205_000000n; // the 76% LTV borrower is at 80.4%, over the 77% LLTV

async function mined(hash: Hex): Promise<void> {
  const receipt = await keeper.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`admin tx ${hash} reverted`);
}

async function coreCall(functionName: string, args: readonly unknown[] = []): Promise<void> {
  // Fixed gas: processBlock runs each action in try/catch, so an estimated limit just big enough for
  // the outer call starves the actions and they're dropped silently.
  await mined(
    await ticker.writeContract({ address: core, abi: coreAbi, functionName, args, gas: 5_000_000n }),
  );
}

/** HyperCore runs the deposits and CoreWriter actions queued in blocks mined so far. */
async function coreProcess(): Promise<void> {
  await coreCall("processBlock");
}

/** Moves market C's lending oracle and HyperCore's oracle/mark (raw px, 3 decimals at szDecimals 3). */
async function setPrice(usd6: bigint, { coreToo = true } = {}): Promise<void> {
  await mined(
    await admin.writeContract({
      address: deployment.markets.C_seiz3.oracle,
      abi: demoOracleAbi,
      functionName: "setPrice",
      args: [usd6 * 10n ** 18n],
    }),
  );
  if (coreToo) await coreCall("setPx", [usd6 / 1000n]);
}

async function setRisk(patch: Partial<{ leverage: number; maxLiquidation: bigint }>): Promise<void> {
  const current = await keeper.publicClient.readContract({
    address: deployment.riskParams,
    abi: riskParamsAbi,
    functionName: "get",
  });
  await mined(
    await admin.writeContract({
      address: deployment.riskParams,
      abi: riskParamsAbi,
      functionName: "setParams",
      args: [{ ...current, ...patch }],
    }),
  );
}

/** A Chainlink CRE market report. On anvil the deployer stands in for the forwarder (DeployHelpers.creForwarder). */
async function creReport(open: boolean, hedgeCapacity: bigint): Promise<void> {
  const { timestamp } = await keeper.publicClient.getBlock();
  const report = encodeAbiParameters(
    [{ type: "bool" }, { type: "uint256" }, { type: "uint64" }],
    [open, hedgeCapacity, timestamp],
  );
  await mined(
    await admin.writeContract({
      address: deployment.riskParams,
      abi: riskParamsAbi,
      functionName: "onReport",
      args: ["0x", report],
    }),
  );
}

async function control(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${cfg.riskEngineUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control failed: ${response.status} ${await response.text()}`);
}

async function snapshot(): Promise<{ state: VaultState; scan: ScanReport }> {
  return readState(keeper.publicClient, cfg);
}

async function decide(): Promise<{ state: VaultState; scan: ScanReport; decision: RiskDecision }> {
  const snap = await snapshot();
  const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, snap.state.blockTimestamp, cfg));
  if (!result.ok) throw new Error(`risk engine failed: ${result.error}`);
  return { ...snap, decision: result.decision };
}

/** Polls until the engine picks `kind` (blocks keep coming every second), e.g. a sync after the order delay. */
async function decideUntil(kind: ActionKind, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await decide();
    if (next.decision.action?.kind === kind) return next;
    if (Date.now() > deadline) {
      throw new Error(`no ${kind} decision; last: ${next.decision.reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function execute(action: Action, state: VaultState, config: Config = cfg): Promise<ExecuteResult> {
  return executeAction({
    publicClient: keeper.publicClient,
    walletClient: keeper.walletClient,
    account: keeper.account,
    nonces: new SingleNonceManager(),
    cfg: config,
    action,
    state,
    now: state.blockTimestamp,
  });
}

/** One full keeper step: decide, send, re-read and check the effect, as the tick loop does. */
async function step(kind: ActionKind): Promise<VaultState> {
  const { state, decision } = await decideUntil(kind);
  const action = decision.action as Action;
  const result = await execute(action, state);
  expect(result, JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? `${v}` : v))).toMatchObject({
    status: "sent",
  });
  const after = (await snapshot()).state;
  expect(verifyEffect(state, after, action)).toMatchObject({ ok: true });
  return after;
}

/** Core size units for an 18-dec NVDAx amount (szDecimals 3). */
const coreUnits = (nvdax: bigint) => nvdax / 10n ** 15n;

let snapshotId: Hex | undefined;
beforeEach(async () => {
  await fetch(`${cfg.riskEngineUrl}/control`, { method: "DELETE" });
  if (snapshotId !== undefined) await anvil.revert({ id: snapshotId });
  snapshotId = await anvil.snapshot();
}, 30_000);

describe("keeper scenarios on the real contracts", () => {
  it("starts idle, holding the margin the next liquidation needs", async () => {
    const { state, decision } = await decide();

    expect(state.borrowers.map((b) => b.address)).toEqual([borrower]);
    expect(state.coreUsdc).toBeGreaterThanOrEqual(state.marginTarget);
    expect(decision).toEqual({ action: null, reason: "core-at-reserve" });
  });

  it("liquidates, hedges, waits out a pool/oracle gap, then unwinds against the short", async () => {
    await setPrice(DROP_USD6);

    // 1. buy the collateral; the vault sends the IOC short in the same tx
    const taken = await step("liquidate");
    expect(taken.inventory).toBeGreaterThan(80n * NVDAX); // capped by the debt, not the 100 NVDAx posted
    expect(taken.pendingHedge.delta).toBe(-coreUnits(taken.inventory));

    // 2. HyperCore fills it; a sync in a later block confirms the short
    await coreProcess();
    const hedged = await step("syncHedge");
    expect(hedged.pendingHedge.delta).toBe(0n);
    expect(hedged.confirmedShort).toBe(-coreUnits(taken.inventory));

    // 3. the pool still trades at $217: unwindStep reverts on the band check, and the keeper only skips it
    const blocked = await decideUntil("unwindStep");
    const skip = await execute(blocked.decision.action as Action, blocked.state);
    expect(skip.status).toBe("simulation-reverted");
    expect(skip).toMatchObject({ reason: expect.stringContaining("OracleBand") });

    // 4. Monday: the price is back. Sell one chunk, then the reduce-only buy brings the short down with it
    await setPrice(START_USD6);
    const unwound = await step("unwindStep");
    expect(unwound.inventory).toBeLessThan(taken.inventory);
    expect(unwound.pendingHedge.delta).toBeGreaterThan(0n);
    await coreProcess();
    const rehedged = await step("syncHedge");
    expect(rehedged.confirmedShort).toBe(-coreUnits(unwound.inventory));
  }, 90_000);

  it("re-sends the rest of a partial fill until the short matches", async () => {
    await coreCall("setFillBps", [5000]);
    await setPrice(DROP_USD6);
    const taken = await step("liquidate");

    await coreProcess();
    const retried = await step("syncHedge");
    expect(retried.pendingHedge.tries).toBe(2n);
    expect(retried.pendingHedge.delta).toBeLessThan(0n);

    await coreCall("setFillBps", [10_000]);
    await coreProcess();
    const hedged = await step("syncHedge");
    expect(hedged.pendingHedge.delta).toBe(0n);
    expect(hedged.confirmedShort).toBe(-coreUnits(taken.inventory));
  }, 90_000);

  it("pauses after maxTries dropped orders, refuses new risk, and recovers on its own", async () => {
    await coreCall("setDropNext", [100]);
    await setPrice(DROP_USD6);
    await step("liquidate");

    for (let i = 0; i < 3; i += 1) {
      await coreProcess();
      await step("syncHedge");
    }
    const stuck = (await snapshot()).state;
    expect(stuck.pauseFlags & PAUSE_HEDGE).toBe(PAUSE_HEDGE);
    expect(stuck.pendingHedge.delta).toBeLessThan(0n);

    await control({
      forceDecision: {
        action: {
          kind: "liquidate",
          marketId: cfg.deployments.marketId,
          borrower,
          seizedAssets: (1n * NVDAX).toString(),
        },
        reason: "forced-liquidate",
      },
    });
    const forced = await decide();
    expect(await execute(forced.decision.action as Action, forced.state)).toEqual({
      status: "skipped",
      reason: "vault-paused",
    });
    await fetch(`${cfg.riskEngineUrl}/control`, { method: "DELETE" });

    await coreCall("setDropNext", [0]);
    await coreProcess();
    const recovered = await step("syncHedge");
    expect(recovered.pauseFlags).toBe(0n);
    expect(recovered.pendingHedge.delta).toBe(0n);
  }, 120_000);

  it("tops up margin when the vault reports a shortfall", async () => {
    await setPrice(DROP_USD6);
    await step("liquidate");
    await coreProcess();
    await step("syncHedge");

    await setRisk({ leverage: 1 }); // the same short now needs 3× the margin
    const short = (await snapshot()).state;
    expect(short.marginShortfall).toBeGreaterThan(0n);

    const { decision } = await decideUntil("topUpMargin");
    expect(decision.action).toEqual({
      kind: "topUpMargin",
      amount: short.marginShortfall + short.marginShortfall / 10n,
    });
    await step("topUpMargin");
    await coreProcess();
    expect((await snapshot()).state.marginShortfall).toBe(0n);
  }, 90_000);

  it("sends back Core margin above what the next liquidation needs", async () => {
    await setRisk({ maxLiquidation: 20_000_000000n }); // marginTarget 20k → 8k
    const before = (await snapshot()).state;
    const excess = before.coreUsdc - before.marginTarget - cfg.coreReserveUsdc;

    const { decision } = await decideUntil("withdrawMargin");
    expect(decision.action).toEqual({ kind: "withdrawMargin", amount: excess });
    await step("withdrawMargin");
    await coreProcess();

    const after = (await snapshot()).state;
    expect(after.coreUsdc).toBe(before.coreUsdc - excess);
    expect(after.idleUsdc).toBe(before.idleUsdc + excess);
  }, 90_000);

  it("skips a liquidation the vault would refuse: lending oracle out of band with HyperCore", async () => {
    await setPrice(DROP_USD6, { coreToo: false });
    const { state, decision } = await decideUntil("liquidate");

    const result = await execute(decision.action as Action, state);
    expect(result.status).toBe("simulation-reverted");
    expect(result).toMatchObject({ reason: expect.stringContaining("OracleBand") });
    expect((await snapshot()).state.inventory).toBe(0n);
  }, 60_000);

  it("simulates but does not send in dry-run mode", async () => {
    await setPrice(DROP_USD6);
    const { state, decision } = await decideUntil("liquidate");

    const result = await execute(decision.action as Action, state, { ...cfg, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect((await snapshot()).state.inventory).toBe(0n);
  }, 60_000);

  it("skips an unsafe forced liquidation of a healthy borrower", async () => {
    await control({
      forceDecision: {
        action: {
          kind: "liquidate",
          marketId: cfg.deployments.marketId,
          borrower,
          seizedAssets: (1n * NVDAX).toString(),
        },
        reason: "forced-healthy",
      },
    });
    const forced = await decide();

    expect(await execute(forced.decision.action as Action, forced.state)).toEqual({
      status: "skipped",
      reason: "borrower-healthy",
    });
  }, 30_000);

  it("surfaces a risk-engine 500 after retries", async () => {
    await control({ failMode: "500" });
    const snap = await snapshot();
    const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, snap.state.blockTimestamp, cfg));

    expect(result).toMatchObject({ ok: false, retriable: true, attempts: cfg.riskEngineRetries + 1 });
  }, 30_000);

  it("rejects malformed risk-engine JSON without retrying", async () => {
    await control({ failMode: "garbage" });
    const snap = await snapshot();
    const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, snap.state.blockTimestamp, cfg));

    expect(result).toMatchObject({ ok: false, retriable: false, attempts: 1 });
  }, 30_000);

  it("honours a forced no-action decision", async () => {
    await control({ forceDecision: { action: null, reason: "forced-idle" } });
    const { decision } = await decide();

    expect(decision).toEqual({ action: null, reason: "forced-idle" });
  }, 30_000);

  // last: these move anvil's clock

  it("sizes the liquidation to the Chainlink CRE hedge capacity", async () => {
    await creReport(false, 2_000_000000n); // HyperCore's book takes $2,000 inside the hedge band
    await setPrice(DROP_USD6);

    const taken = await step("liquidate");
    expect((taken.inventory * DROP_USD6) / NVDAX).toBeLessThanOrEqual(2_000_000000n);
    expect(taken.inventory).toBeGreaterThan(9n * NVDAX); // the debt alone would take > 80 NVDAx
    expect(taken.pendingHedge.delta).toBe(-coreUnits(taken.inventory));
  }, 60_000);

  it("stops liquidating once the CRE report is stale", async () => {
    await creReport(true, 50_000_000000n);
    await setPrice(DROP_USD6);
    await anvil.increaseTime({ seconds: 301 }); // RiskParams.maxReportAge is 300
    await anvil.mine({ blocks: 1 });

    const { state, decision } = await decide();
    expect(state.risk.maxLiquidation).toBe(0n);
    expect(state.marketOpen).toBe(false);
    expect(decision.action?.kind).not.toBe("liquidate");
  }, 60_000);
});
