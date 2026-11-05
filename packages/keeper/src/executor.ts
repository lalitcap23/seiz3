import type { PublicClient, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import { vaultAbi } from "./abi.js";
import { guards } from "./guards.js";
import { describeError } from "./riskEngine.js";
import type { SingleNonceManager } from "./clients.js";
import type { Action, Config, VaultState } from "./types.js";

export type ExecuteResult =
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "simulation-reverted"; readonly reason: string }
  | { readonly status: "estimate-failed"; readonly reason: string }
  | { readonly status: "dry-run"; readonly gas: bigint }
  | { readonly status: "send-failed"; readonly reason: string }
  | { readonly status: "receipt-timeout"; readonly hash: `0x${string}` }
  | { readonly status: "reverted"; readonly hash: `0x${string}`; readonly reason: string }
  | {
      readonly status: "sent";
      readonly hash: `0x${string}`;
      readonly gas: bigint;
      readonly blockNumber: bigint;
    };

export interface ExecuteParams {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: PrivateKeyAccount;
  readonly nonces: SingleNonceManager;
  readonly cfg: Config;
  readonly action: Action;
  readonly state: VaultState;
  readonly now: bigint;
}

export async function executeAction(params: ExecuteParams): Promise<ExecuteResult> {
  const { publicClient, walletClient, account, nonces, cfg, action, state, now } = params;

  const guard = guards(action, state, now, cfg);
  if (!guard.ok) return { status: "skipped", reason: guard.reason };

  let simulation;
  try {
    simulation = await simulate(action, publicClient, cfg, account);
  } catch (error) {
    return { status: "simulation-reverted", reason: describeError(error) };
  }

  let estimated: bigint;
  try {
    estimated = await publicClient.estimateContractGas(simulation.request as never);
  } catch (error) {
    return { status: "estimate-failed", reason: describeError(error) };
  }

  const withMargin = (estimated * (10_000n + cfg.gasLimitMarginBps)) / 10_000n;
  const gas = withMargin > cfg.gasLimitCap ? cfg.gasLimitCap : withMargin;

  if (cfg.dryRun) return { status: "dry-run", gas };

  const nonce = await nonces.consume(publicClient, account.address);
  let hash: `0x${string}`;
  try {
    hash = await walletClient.writeContract({
      ...(simulation.request as object),
      gas,
      nonce,
    } as never);
  } catch (error) {
    nonces.reset();
    return { status: "send-failed", reason: describeError(error) };
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: cfg.txTimeoutMs });
  } catch {
    nonces.reset();
    return { status: "receipt-timeout", hash };
  }

  if (receipt.status !== "success") {
    return { status: "reverted", hash, reason: "receipt status reverted" };
  }
  return { status: "sent", hash, gas, blockNumber: receipt.blockNumber };
}

async function simulate(
  action: Action,
  publicClient: PublicClient,
  cfg: Config,
  account: PrivateKeyAccount,
) {
  const base = { address: cfg.vault, abi: vaultAbi, account } as const;
  switch (action.kind) {
    case "syncHedge":
      return publicClient.simulateContract({ ...base, functionName: "syncHedge" });
    case "unwindStep":
      return publicClient.simulateContract({ ...base, functionName: "unwindStep" });
    case "topUpMargin":
      return publicClient.simulateContract({
        ...base,
        functionName: "topUpMargin",
        args: [action.amount],
      });
    case "withdrawMargin":
      return publicClient.simulateContract({
        ...base,
        functionName: "withdrawMargin",
        args: [action.amount],
      });
    case "liquidate":
      return publicClient.simulateContract({
        ...base,
        functionName: "liquidate",
        args: [action.marketId, action.borrower, action.seizedAssets],
      });
  }
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly detail: string;
}

export function verifyEffect(before: VaultState, after: VaultState, action: Action): VerifyResult {
  switch (action.kind) {
    case "syncHedge": {
      const cleared = after.pendingHedge.delta === 0n;
      const retried = after.pendingHedge.tries > before.pendingHedge.tries;
      return {
        ok: cleared || retried,
        detail: cleared
          ? "pending cleared"
          : retried
            ? `tries ${before.pendingHedge.tries} -> ${after.pendingHedge.tries}`
            : "pending unchanged",
      };
    }
    case "liquidate": {
      const tookInventory = after.inventory > before.inventory;
      const sentHedge = after.pendingHedge.delta !== 0n;
      return {
        ok: tookInventory && sentHedge,
        detail: `inventory ${before.inventory} -> ${after.inventory}, pending ${after.pendingHedge.delta}`,
      };
    }
    case "unwindStep": {
      const reduced = after.inventory < before.inventory;
      return {
        ok: reduced,
        detail: `inventory ${before.inventory} -> ${after.inventory}`,
      };
    }
    case "topUpMargin": {
      const moved = after.coreUsdc > before.coreUsdc;
      return {
        ok: moved,
        detail: `coreUsdc ${before.coreUsdc} -> ${after.coreUsdc}`,
      };
    }
    case "withdrawMargin": {
      const moved = after.coreUsdc < before.coreUsdc;
      return {
        ok: moved,
        detail: `coreUsdc ${before.coreUsdc} -> ${after.coreUsdc}`,
      };
    }
  }
}
