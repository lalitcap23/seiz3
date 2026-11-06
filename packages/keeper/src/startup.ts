import { afterbellVaultAbi } from "@afterbell/shared/abis";

import type { KeeperClients } from "./clients.js";
import { sameAddress } from "./riskCalc.js";
import { describeError } from "./riskEngine.js";
import { readState } from "./state.js";
import type { Config } from "./types.js";

export interface StartupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface StartupReport {
  readonly checks: readonly StartupCheck[];
}

export class StartupError extends Error {
  readonly checks: readonly StartupCheck[];

  constructor(checks: readonly StartupCheck[]) {
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    super(`startup checks failed: ${failed.join("; ")}`);
    this.name = "StartupError";
    this.checks = checks;
  }
}

export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  if (cfg.tickMs < 100 || cfg.tickMs > 60_000) errors.push("tickMs must be between 100 and 60000");
  if (cfg.maxConsecutiveReverts < 1) errors.push("maxConsecutiveReverts must be >= 1");
  if (cfg.maxActionsPerMinute < 1) errors.push("maxActionsPerMinute must be >= 1");
  if (cfg.riskEngineTimeoutMs < 100) errors.push("riskEngineTimeoutMs must be >= 100");
  if (cfg.riskEngineRetries < 0 || cfg.riskEngineRetries > 10) {
    errors.push("riskEngineRetries must be between 0 and 10");
  }
  if (cfg.gasLimitCap <= 0n || cfg.gasLimitCap > 3_000_000n) {
    errors.push("gasLimitCap must be between 1 and 3,000,000");
  }
  if (cfg.gasLimitMarginBps < 0n || cfg.gasLimitMarginBps > 10_000n) {
    errors.push("gasLimitMarginBps must be between 0 and 10000");
  }
  if (cfg.idleReserveUsdc < 0n || cfg.coreReserveUsdc < 0n) {
    errors.push("USDC reserves must be >= 0");
  }
  if (/^0x0{64}$/.test(cfg.deployments.marketId)) errors.push("marketId is required");
  if (cfg.chainId <= 0n) errors.push("chainId must be > 0");
  if (cfg.healthPort < 1 || cfg.healthPort > 65_535) errors.push("healthPort is invalid");
  if (cfg.riskEngineUrl.trim() === "") errors.push("riskEngineUrl is required");
  if (cfg.morphoApiEnabled && cfg.morphoApiUrl.trim() === "") {
    errors.push("morphoApiUrl is required when the Morpho API is enabled");
  }
  if (cfg.morphoApiTimeoutMs < 100) errors.push("morphoApiTimeoutMs must be >= 100");
  if (cfg.morphoApiIntervalMs < 1000) errors.push("morphoApiIntervalMs must be >= 1000");
  if (cfg.morphoApiMaxPositions < 1 || cfg.morphoApiMaxPositions > 500) {
    errors.push("morphoApiMaxPositions must be between 1 and 500");
  }
  if (cfg.vault.toLowerCase() === cfg.morpho.toLowerCase()) {
    errors.push("vault and morpho must be different addresses");
  }
  return errors;
}

export async function runStartup(
  cfg: Config,
  clients: KeeperClients,
  onCheck: (check: StartupCheck) => void = () => undefined,
): Promise<StartupReport> {
  const checks: StartupCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    const check = { name, ok, detail };
    checks.push(check);
    onCheck(check);
  };

  const configErrors = validateConfig(cfg);
  add("config", configErrors.length === 0, configErrors.length === 0 ? "valid" : configErrors.join("; "));
  if (configErrors.length > 0) throw new StartupError(checks);

  try {
    const chainId = await clients.publicClient.getChainId();
    add(
      "rpc",
      chainId === Number(cfg.chainId),
      `rpc chainId ${chainId}, expected ${cfg.chainId.toString()}`,
    );
  } catch (error) {
    add("rpc", false, describeError(error));
    throw new StartupError(checks);
  }

  try {
    const [vaultCode, morphoCode] = await Promise.all([
      clients.publicClient.getBytecode({ address: cfg.vault }),
      clients.publicClient.getBytecode({ address: cfg.morpho }),
    ]);
    add("vault-code", vaultCode !== undefined && vaultCode !== "0x", cfg.vault);
    add("morpho-code", morphoCode !== undefined && morphoCode !== "0x", cfg.morpho);
  } catch (error) {
    add("contract-code", false, describeError(error));
  }

  // The deployment file and the chain must agree: same Morpho, and a market the vault will liquidate.
  try {
    const vault = { address: cfg.vault, abi: afterbellVaultAbi } as const;
    const [morpho, allowed] = await Promise.all([
      clients.publicClient.readContract({ ...vault, functionName: "morpho" }),
      clients.publicClient.readContract({
        ...vault,
        functionName: "marketAllowed",
        args: [cfg.deployments.marketId],
      }),
    ]);
    add("vault-morpho", sameAddress(morpho, cfg.morpho), `vault.morpho() -> ${morpho}`);
    add("market-allowed", allowed, `vault.marketAllowed(${cfg.deployments.marketId}) -> ${allowed}`);
  } catch (error) {
    add("vault-wiring", false, describeError(error));
  }

  // One full tick's reads: every ABI the keeper uses, against the live contracts and HyperCore reads.
  try {
    const { state } = await readState(clients.publicClient, cfg);
    add(
      "state-read",
      true,
      `block ${state.blockNumber}: inventory ${state.inventory}, pauseFlags ${state.pauseFlags}, ` +
        `${state.borrowers.length} borrower(s)`,
    );
  } catch (error) {
    add("state-read", false, describeError(error));
  }

  try {
    const balance = await clients.publicClient.getBalance({ address: clients.account.address });
    add(
      "signer-gas",
      balance >= cfg.minSignerBalanceWei,
      `${balance.toString()} wei (min ${cfg.minSignerBalanceWei.toString()})`,
    );
  } catch (error) {
    add("signer-gas", false, describeError(error));
  }

  if (checks.some((c) => !c.ok)) throw new StartupError(checks);
  return { checks };
}
