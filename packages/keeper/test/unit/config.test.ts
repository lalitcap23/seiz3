import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import { DUMMY_KEY, MORPHO, VAULT } from "./fixtures.js";

const MARKET_C = `0x${"cc".repeat(32)}`;

/** Shaped like deployments/<network>.json after Deploy.s.sol + CreateMarkets.s.sol (+ a borrower list). */
const deployment = {
  chainId: 31337,
  usdc: "0x00000000000000000000000000000000000000c1",
  morpho: MORPHO,
  vault: VAULT,
  riskParams: "0x00000000000000000000000000000000000000c2",
  poolKey: { currency0: VAULT, currency1: MORPHO, fee: 3000, tickSpacing: 60, hooks: VAULT },
  hypercore: { perpAsset: 110002, perpIndex: 10002, perpDexIndex: 1, szDecimals: 3 },
  markets: {
    A_naive: { id: `0x${"aa".repeat(32)}`, oracle: VAULT, lltv: "770000000000000000" },
    B_conservative: { id: `0x${"bb".repeat(32)}`, oracle: VAULT, lltv: "385000000000000000" },
    C_afterbell: { id: MARKET_C, oracle: VAULT, lltv: "770000000000000000" },
  },
  borrowers: [{ address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: "C_afterbell" }],
};

const baseEnv: NodeJS.ProcessEnv = {
  RPC_URL: "http://chain:8545",
  KEEPER_PK: DUMMY_KEY,
  RISK_ENGINE_URL: "http://risk-engine:8081",
  DEPLOYMENTS_PATH: "/shared/testnet.json",
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
    expect(cfg.deployments.borrowers[0]).toEqual({
      address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      label: "C_afterbell",
    });
  });

  it("works market C, the one the vault allow-lists", () => {
    expect(loadConfig(baseEnv, readDeployment).deployments.marketId).toBe(MARKET_C);
  });

  it("accepts a deployment without a borrower list", () => {
    const { borrowers: _omitted, ...bare } = deployment;
    const cfg = loadConfig(baseEnv, () => JSON.stringify(bare));

    expect(cfg.deployments.borrowers).toEqual([]);
  });

  it("explains a deployment that has no markets yet", () => {
    const { markets: _omitted, ...bare } = deployment;

    expect(() => loadConfig(baseEnv, () => JSON.stringify(bare))).toThrow(/deployments\.markets/);
  });

  it("parses decimal reserves and gas settings", () => {
    const cfg = loadConfig(
      {
        ...baseEnv,
        IDLE_RESERVE_USDC: "12.5",
        CORE_RESERVE_USDC: "1",
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
    expect(cfg.tickMs).toBe(2500);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.killSwitchEnv).toBe(true);
    expect(cfg.maxActionsPerMinute).toBe(3);
    expect(cfg.maxConsecutiveReverts).toBe(4);
    expect(cfg.gasLimitCap).toBe(2_000_000n);
  });

  it("falls back to VAULT / MORPHO / MARKET_ID from the env", () => {
    const { DEPLOYMENTS_PATH: _omitted, ...env } = baseEnv;
    const cfg = loadConfig({ ...env, VAULT, MORPHO, MARKET_ID: MARKET_C }, readDeployment);

    expect(cfg.deployments).toEqual({
      chainId: 31337n,
      vault: VAULT,
      morpho: MORPHO,
      marketId: MARKET_C,
      borrowers: [],
    });
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
