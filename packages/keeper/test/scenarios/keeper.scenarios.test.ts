import { createWalletClient, http, parseAbi, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { makeChain, makeClients, SingleNonceManager, type KeeperClients } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { executeAction, type ExecuteResult } from "../../src/executor.js";
import { RiskEngineClient, buildRiskRequest } from "../../src/riskEngine.js";
import { readState } from "../../src/state.js";
import type { Action, Config, RiskDecision, ScanReport, VaultState } from "../../src/types.js";

const USDC = 1_000_000n;
const NVDAX = 10n ** 18n;
const MAX_LIQUIDATION = 1000n * USDC;

const cfg = loadConfig();
const keeper: KeeperClients = makeClients(cfg);
const riskEngine = new RiskEngineClient(cfg);

const deployerPk = (process.env["DEPLOYER_PK"] ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
const deployer: PrivateKeyAccount = privateKeyToAccount(deployerPk);
const admin: WalletClient = createWalletClient({
  account: deployer,
  chain: makeChain(cfg),
  transport: http(cfg.rpcUrl),
});

const vaultAdminAbi = parseAbi([
  "function setState(uint256 inventory, int64 confirmedShort, uint256 idleUsdc, uint256 coreUsdc, uint256 marginRatioBps, bool paused)",
  "function clearPending()",
  "function setPending(int64 delta, uint64 sentBlock, uint64 sentAt, uint8 tries)",
  "function setRevertAll(bool revert)",
  "function setFillMode(uint8 mode)",
  "function setPoolPriceInBand(bool inBand)",
  "function setMarketOpen(bool open)",
  "function setLastUnwindAt(uint64 timestamp)",
  "function setPaused(bool paused)",
  "function setRisk((uint256 maxLiquidation, uint32 hedgeLeverage, uint32 marginBufferBps, uint32 maxUnhedgedBps, uint32 maxSlippageBps, uint32 oracleBandBps, uint8 maxTries, uint32 orderDelaySec, uint32 unwindCooldownSec))",
]);

const morphoAdminAbi = parseAbi([
  "function setBorrower(address borrower, uint256 collateral, uint256 borrowAssets)",
]);

const borrowerA = cfg.deployments.borrowers[0]?.address;
const borrowerB = cfg.deployments.borrowers[1]?.address;
if (borrowerA === undefined || borrowerB === undefined) {
  throw new Error("deployments.json must include two borrowers");
}

const defaultRisk = {
  maxLiquidation: MAX_LIQUIDATION,
  hedgeLeverage: 3,
  marginBufferBps: 1000,
  maxUnhedgedBps: 200,
  maxSlippageBps: 100,
  oracleBandBps: 200,
  maxTries: 3,
  orderDelaySec: 0,
  unwindCooldownSec: 10,
};

async function adminWrite(
  address: `0x${string}`,
  abi: typeof vaultAdminAbi | typeof morphoAdminAbi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = await admin.writeContract({ address, abi, functionName, args } as never);
  await keeper.publicClient.waitForTransactionReceipt({ hash });
}

async function control(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${cfg.riskEngineUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control failed: ${response.status} ${await response.text()}`);
}

async function clearControl(): Promise<void> {
  await fetch(`${cfg.riskEngineUrl}/control`, { method: "DELETE" });
}

async function reset(): Promise<void> {
  await clearControl();
  await adminWrite(cfg.vault, vaultAdminAbi, "clearPending", []);
  await adminWrite(cfg.vault, vaultAdminAbi, "setRevertAll", [false]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setFillMode", [2]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setPoolPriceInBand", [true]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setMarketOpen", [true]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setLastUnwindAt", [0n]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setRisk", [defaultRisk]);
  await adminWrite(cfg.vault, vaultAdminAbi, "setState", [
    0n,
    0n,
    100_000n * USDC,
    0n,
    5000n,
    false,
  ]);
  await adminWrite(cfg.morpho, morphoAdminAbi, "setBorrower", [borrowerA, 10n * NVDAX, 900n * USDC]);
  await adminWrite(cfg.morpho, morphoAdminAbi, "setBorrower", [borrowerB, 10n * NVDAX, 700n * USDC]);
}

async function snapshot(): Promise<{ state: VaultState; scan: ScanReport }> {
  return readState(keeper.publicClient, cfg, BigInt(Math.floor(Date.now() / 1000)));
}

async function decide(): Promise<{ state: VaultState; scan: ScanReport; decision: RiskDecision }> {
  const snap = await snapshot();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, now, cfg));
  if (!result.ok) throw new Error(`risk engine failed: ${result.error}`);
  return { ...snap, decision: result.decision };
}

async function execute(
  action: Action,
  state: VaultState,
  config: Config = cfg,
): Promise<ExecuteResult> {
  return executeAction({
    publicClient: keeper.publicClient,
    walletClient: keeper.walletClient,
    account: keeper.account,
    nonces: new SingleNonceManager(),
    cfg: config,
    action,
    state,
    now: BigInt(Math.floor(Date.now() / 1000)),
  });
}

async function waitOneBlock(after: bigint): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if ((await keeper.publicClient.getBlockNumber()) > after) {
      await sleep(200);
      return;
    }
    await sleep(500);
  }
  throw new Error(`no block after ${after}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  await reset();
}, 60_000);

describe("keeper scenarios", () => {
  it("liquidates, hedges, unwinds, then idles", async () => {
    const first = await decide();
    expect(first.decision.action).toMatchObject({ kind: "liquidate", borrower: borrowerA });

    const liquidation = await execute(first.decision.action as Action, first.state);
    expect(liquidation.status).toBe("sent");

    let snap = await snapshot();
    expect(snap.state.inventory).toBe(10n * NVDAX);
    expect(snap.state.pendingHedge.delta).not.toBe(0n);

    await waitOneBlock(snap.state.blockNumber);
    const sync = await decide();
    expect(sync.decision.action).toEqual({ kind: "syncHedge" });
    expect((await execute(sync.decision.action as Action, sync.state)).status).toBe("sent");

    snap = await snapshot();
    expect(snap.state.pendingHedge.delta).toBe(0n);
    expect(snap.state.inventory).toBe(10n * NVDAX);

    const unwind = await decide();
    expect(unwind.decision.action).toEqual({ kind: "unwindStep" });
    expect((await execute(unwind.decision.action as Action, unwind.state)).status).toBe("sent");

    snap = await snapshot();
    expect(snap.state.inventory).toBe(0n);
    expect(snap.state.confirmedShort).toBe(0n);
    expect((await decide()).decision.action).toBeNull();
  }, 30_000);

  it("retries a partial hedge before a full fill", async () => {
    await adminWrite(cfg.vault, vaultAdminAbi, "setFillMode", [1]);
    const block = await keeper.publicClient.getBlockNumber();
    await adminWrite(cfg.vault, vaultAdminAbi, "setPending", [-1000n, block - 1n, 0n, 0n]);

    const partial = await decide();
    expect(partial.decision.action).toEqual({ kind: "syncHedge" });
    expect((await execute(partial.decision.action as Action, partial.state)).status).toBe("sent");

    let snap = await snapshot();
    expect(snap.state.pendingHedge.delta).toBe(-500n);
    expect(snap.state.pendingHedge.tries).toBe(1n);

    await adminWrite(cfg.vault, vaultAdminAbi, "setFillMode", [2]);
    await waitOneBlock(snap.state.blockNumber);
    const full = await decide();
    expect(full.decision.action).toEqual({ kind: "syncHedge" });
    expect((await execute(full.decision.action as Action, full.state)).status).toBe("sent");

    snap = await snapshot();
    expect(snap.state.pendingHedge.delta).toBe(0n);
    expect(snap.state.confirmedShort).toBe(-1000n);
  }, 30_000);

  it("pauses after max retries and refuses new risk", async () => {
    await adminWrite(cfg.vault, vaultAdminAbi, "setRisk", [{ ...defaultRisk, maxTries: 2 }]);
    await adminWrite(cfg.vault, vaultAdminAbi, "setFillMode", [0]);
    const block = await keeper.publicClient.getBlockNumber();
    await adminWrite(cfg.vault, vaultAdminAbi, "setPending", [-1000n, block - 1n, 0n, 1n]);

    const retry = await decide();
    expect(retry.decision.action).toEqual({ kind: "syncHedge" });
    expect((await execute(retry.decision.action as Action, retry.state)).status).toBe("sent");

    const stuck = await snapshot();
    expect(stuck.state.paused).toBe(true);
    expect(stuck.state.pendingHedge.delta).toBe(-1000n);

    await control({
      forceDecision: {
        action: {
          kind: "liquidate",
          marketId: cfg.deployments.marketId,
          borrower: borrowerA,
          seizedAssets: (10n * NVDAX).toString(),
        },
        reason: "forced-liquidate",
      },
    });
    const forced = await decide();
    const result = await execute(forced.decision.action as Action, forced.state);
    expect(result).toEqual({ status: "skipped", reason: "vault-paused" });
  }, 30_000);

  it("surfaces a risk-engine 500 after retries", async () => {
    await control({ failMode: "500" });
    const snap = await snapshot();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, now, cfg));

    expect(result).toMatchObject({ ok: false, retriable: true, attempts: cfg.riskEngineRetries + 1 });
  }, 30_000);

  it("rejects malformed risk-engine JSON without retrying", async () => {
    await control({ failMode: "garbage" });
    const snap = await snapshot();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const result = await riskEngine.decide(buildRiskRequest(snap.state, snap.scan, now, cfg));

    expect(result).toMatchObject({ ok: false, retriable: false, attempts: 1 });
  }, 30_000);

  it("honours a forced no-action decision", async () => {
    await control({ forceDecision: { action: null, reason: "forced-idle" } });
    const snap = await decide();

    expect(snap.decision.action).toBeNull();
    expect(snap.decision.reason).toBe("forced-idle");
  }, 30_000);

  it("skips an unsafe forced liquidation of a healthy borrower", async () => {
    await control({
      forceDecision: {
        action: {
          kind: "liquidate",
          marketId: cfg.deployments.marketId,
          borrower: borrowerB,
          seizedAssets: (10n * NVDAX).toString(),
        },
        reason: "forced-healthy",
      },
    });
    const forced = await decide();
    const result = await execute(forced.decision.action as Action, forced.state);

    expect(result).toEqual({ status: "skipped", reason: "borrower-healthy" });
  }, 30_000);

  it("simulates but does not send in dry-run mode", async () => {
    await control({
      forceDecision: {
        action: {
          kind: "liquidate",
          marketId: cfg.deployments.marketId,
          borrower: borrowerA,
          seizedAssets: (10n * NVDAX).toString(),
        },
        reason: "forced-liquidate",
      },
    });
    const forced = await decide();
    const before = forced.state;
    const result = await execute(forced.decision.action as Action, before, { ...cfg, dryRun: true });

    expect(result.status).toBe("dry-run");
    const after = await snapshot();
    expect(after.state.inventory).toBe(before.inventory);
    expect(after.state.pendingHedge.delta).toBe(0n);
  }, 30_000);

  it("tops up margin when the buffer is breached", async () => {
    await adminWrite(cfg.vault, vaultAdminAbi, "setState", [
      0n,
      0n,
      100_000n * USDC,
      0n,
      500n,
      false,
    ]);

    const decision = await decide();
    expect(decision.decision.action).toMatchObject({
      kind: "topUpMargin",
      amount: cfg.topUpUsdc,
    });
    expect((await execute(decision.decision.action as Action, decision.state)).status).toBe("sent");

    const snap = await snapshot();
    expect(snap.state.coreUsdc).toBe(cfg.topUpUsdc);
    expect(snap.state.marginRatioBps).toBe(1500n);
  }, 30_000);

  it("withdraws margin down to the configured reserve", async () => {
    await adminWrite(cfg.morpho, morphoAdminAbi, "setBorrower", [borrowerA, 10n * NVDAX, 0n]);
    await adminWrite(cfg.vault, vaultAdminAbi, "setState", [
      0n,
      0n,
      100_000n * USDC,
      5000n * USDC,
      5000n,
      false,
    ]);

    const decision = await decide();
    expect(decision.decision.action).toMatchObject({
      kind: "withdrawMargin",
      amount: 5000n * USDC - cfg.coreReserveUsdc,
    });
    expect((await execute(decision.decision.action as Action, decision.state)).status).toBe("sent");

    const snap = await snapshot();
    expect(snap.state.coreUsdc).toBe(cfg.coreReserveUsdc);
  }, 30_000);

  it("blocks unwinds while the pool is out of band", async () => {
    await adminWrite(cfg.morpho, morphoAdminAbi, "setBorrower", [borrowerA, 10n * NVDAX, 0n]);
    await adminWrite(cfg.vault, vaultAdminAbi, "setState", [
      10n * NVDAX,
      -1000n,
      100_000n * USDC,
      0n,
      5000n,
      false,
    ]);
    await adminWrite(cfg.vault, vaultAdminAbi, "setPoolPriceInBand", [false]);

    const blocked = await decide();
    expect(blocked.decision.action).toBeNull();
    expect(blocked.decision.reason).toBe("pool-out-of-band");

    await adminWrite(cfg.vault, vaultAdminAbi, "setPoolPriceInBand", [true]);
    const allowed = await decide();
    expect(allowed.decision.action).toEqual({ kind: "unwindStep" });
  }, 30_000);

  it("waits for a later block and the order delay", async () => {
    const block = await keeper.publicClient.getBlockNumber();
    await adminWrite(cfg.vault, vaultAdminAbi, "setPending", [
      -1000n,
      block + 100n,
      BigInt(Math.floor(Date.now() / 1000)),
      1n,
    ]);

    const sameBlock = await decide();
    expect(sameBlock.decision).toEqual({ action: null, reason: "wait-same-block" });

    await adminWrite(cfg.vault, vaultAdminAbi, "setPending", [
      -1000n,
      block - 1n,
      BigInt(Math.floor(Date.now() / 1000)) + 3600n,
      1n,
    ]);
    const delayed = await decide();
    expect(delayed.decision).toEqual({ action: null, reason: "wait-order-delay" });
  }, 30_000);
});
