import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import { DUMMY_KEY, MORPHO, VAULT } from "./fixtures.js";

const deployment = {
  chainId: 31337,
  vault: VAULT,
  morpho: MORPHO,
  marketId: `0x${"11".repeat(32)}`,
  lltv: "800000000000000000",
  price: "100000000000000000000000000",
  szDecimals: 2,
  orderDelaySec: 5,
  unwindCooldownOpenSec: 2,
  keeperAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  borrowers: [
    {
      address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      collateral: "10000000000000000000",
      borrowAssets: "900000000",
      label: "liquidatable",
    },
  ],
};

const baseEnv: NodeJS.ProcessEnv = {
  RPC_URL: "http://chain:8545",
  KEEPER_PK: DUMMY_KEY,
  RISK_ENGINE_URL: "http://risk-engine:8081",
};

const readDeployment = () => JSON.stringify(deployment);

describe("config: loadConfig", () => {
  it("loads env and deployments with defaults", () => {
    const cfg = loadConfig(baseEnv, readDeployment);

    expect(cfg.chainId).toBe(31337n);
    expect(cfg.vault).toBe(VAULT);
    expect(cfg.morpho).toBe(MORPHO);
    expect(cfg.riskEngineUrl).toBe("http://risk-engine:8081");
    expect(cfg.tickMs).toBe(1000);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.killSwitchEnv).toBe(false);
    expect(cfg.unwindCooldownOpenSec).toBe(2n);
    expect(cfg.deployments.borrowers[0]).toMatchObject({
      address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      collateral: 10_000_000_000_000_000_000n,
      borrowAssets: 900_000_000n,
      label: "liquidatable",
    });
  });

  it("parses decimal reserves and gas settings", () => {
    const cfg = loadConfig(
      {
        ...baseEnv,
        IDLE_RESERVE_USDC: "12.5",
        CORE_RESERVE_USDC: "1",
        TOPUP_USDC: "250",
        TICK_MS: "2500",
        DRY_RUN: "true",
        KILL_SWITCH: "1",
        MAX_ACTIONS_PER_MINUTE: "3",
        MAX_CONSECUTIVE_REVERTS: "4",
        GAS_LIMIT_CAP: "2000000",
      },
      readDeployment,
    );

    expect(cfg.idleReserveUsdc).toBe(12_500_000n);
    expect(cfg.coreReserveUsdc).toBe(1_000_000n);
    expect(cfg.topUpUsdc).toBe(250_000_000n);
    expect(cfg.tickMs).toBe(2500);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.killSwitchEnv).toBe(true);
    expect(cfg.maxActionsPerMinute).toBe(3);
    expect(cfg.maxConsecutiveReverts).toBe(4);
    expect(cfg.gasLimitCap).toBe(2_000_000n);
  });

  it("lets the env override the deployed open cooldown", () => {
    const cfg = loadConfig({ ...baseEnv, UNWIND_COOLDOWN_OPEN_SEC: "9" }, readDeployment);

    expect(cfg.unwindCooldownOpenSec).toBe(9n);
  });

  it("fails fast when the deployments file cannot be read", () => {
    expect(() =>
      loadConfig(baseEnv, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(ConfigError);
  });

  it("fails fast on invalid JSON", () => {
    expect(() => loadConfig(baseEnv, () => "{oops")).toThrow(/not valid JSON/);
  });

  it("fails fast on a missing required env var", () => {
    expect(() => loadConfig({ KEEPER_PK: DUMMY_KEY }, readDeployment)).toThrow(/RPC_URL/);
  });

  it("fails fast on a malformed private key", () => {
    expect(() =>
      loadConfig({ ...baseEnv, KEEPER_PK: "0x1234" }, readDeployment),
    ).toThrow(/KEEPER_PK/);
  });

  it("fails fast on malformed deployments", () => {
    expect(() =>
      loadConfig(baseEnv, () => JSON.stringify({ ...deployment, borrowers: [{ address: "0x1" }] })),
    ).toThrow(/deployments/);
  });

  it("fails fast on a bad tick rate", () => {
    expect(() => loadConfig({ ...baseEnv, TICK_MS: "10" }, readDeployment)).toThrow(/TICK_MS/);
  });

  it("fails fast on a bad reserve decimal", () => {
    expect(() =>
      loadConfig({ ...baseEnv, IDLE_RESERVE_USDC: "1.1234567" }, readDeployment),
    ).toThrow(/IDLE_RESERVE_USDC/);
  });
});
