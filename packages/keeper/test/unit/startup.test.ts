import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/startup.js";
import { makeConfig, MORPHO, VAULT } from "./fixtures.js";

describe("startup: validateConfig", () => {
  it("accepts the default config", () => {
    expect(validateConfig(makeConfig())).toEqual([]);
  });

  it("rejects a tick rate outside the safe range", () => {
    expect(validateConfig(makeConfig({ tickMs: 50 }))).toContain(
      "tickMs must be between 100 and 60000",
    );
    expect(validateConfig(makeConfig({ tickMs: 60_001 }))).toHaveLength(1);
  });

  it("rejects invalid breaker settings", () => {
    expect(validateConfig(makeConfig({ maxConsecutiveReverts: 0 }))).toContain(
      "maxConsecutiveReverts must be >= 1",
    );
    expect(validateConfig(makeConfig({ maxActionsPerMinute: 0 }))).toContain(
      "maxActionsPerMinute must be >= 1",
    );
  });

  it("rejects a gas cap above the 3M limit", () => {
    expect(validateConfig(makeConfig({ gasLimitCap: 3_000_001n }))).toContain(
      "gasLimitCap must be between 1 and 3,000,000",
    );
    expect(validateConfig(makeConfig({ gasLimitCap: 0n }))).toHaveLength(1);
  });

  it("rejects bad risk-engine settings", () => {
    expect(validateConfig(makeConfig({ riskEngineTimeoutMs: 10 }))).toContain(
      "riskEngineTimeoutMs must be >= 100",
    );
    expect(validateConfig(makeConfig({ riskEngineRetries: 11 }))).toContain(
      "riskEngineRetries must be between 0 and 10",
    );
    expect(validateConfig(makeConfig({ riskEngineUrl: "  " }))).toContain(
      "riskEngineUrl is required",
    );
  });

  it("rejects negative reserves and cooldowns", () => {
    expect(validateConfig(makeConfig({ idleReserveUsdc: -1n }))).toContain(
      "USDC reserves and topUpUsdc must be >= 0",
    );
    expect(validateConfig(makeConfig({ unwindCooldownOpenSec: -1n }))).toContain(
      "unwindCooldownOpenSec must be >= 0",
    );
  });

  it("rejects the vault being used as the Morpho address", () => {
    const errors = validateConfig(makeConfig({ morpho: VAULT }));

    expect(errors).toContain("vault and morpho must be different addresses");
    expect(VAULT).not.toBe(MORPHO);
  });

  it("rejects an invalid health port", () => {
    expect(validateConfig(makeConfig({ healthPort: 0 }))).toContain("healthPort is invalid");
  });
});
