import { existsSync } from "node:fs";
import type { Hex } from "viem";
import { coreOracleUsd6, followOracles, rebalancePool } from "./evmBots.js";
import { log, owner } from "./chain.js";
import { MarketMaker } from "./marketMaker.js";
import { checkAlerts } from "./alerts.js";
import { bots, env } from "./env.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `step` forever, `everyMs` apart; a failed round is logged and the loop carries on. */
async function loop(name: string, everyMs: number, step: () => Promise<void>): Promise<never> {
  for (;;) {
    try {
      await step();
    } catch (error) {
      log(name, "error", { error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
    await sleep(everyMs);
  }
}

const running: Promise<never>[] = [];

if (bots.has("oracle") || bots.has("pool")) {
  if (owner === null) throw new Error("the oracle and pool bots need DEPLOYER_PRIVATE_KEY (the oracles' owner)");
  // one loop, so the two never race for the deployer's nonce
  running.push(
    loop("evm", env.EVM_INTERVAL_MS, async () => {
      if (existsSync(env.HOLD_FILE)) return; // presenter crash in progress: the oracles are off on purpose
      const core = await coreOracleUsd6();
      if (bots.has("oracle")) await followOracles(core);
      if (bots.has("pool")) await rebalancePool(core);
    }),
  );
}

const mm =
  env.HL_MM_PRIVATE_KEY === undefined
    ? null
    : new MarketMaker(env.HL_MM_PRIVATE_KEY as Hex, env.HL_MM_ACCOUNT as Hex | undefined);
if (bots.has("mm")) {
  if (mm === null) throw new Error("the mm bot needs HL_MM_PRIVATE_KEY");
  log("mm", "account", await mm.account());
  running.push(loop("mm", env.MM_INTERVAL_MS, () => mm.tick()));
}

if (bots.has("alerts")) running.push(loop("alerts", env.ALERT_INTERVAL_MS, () => checkAlerts(mm)));

log("bots", `running ${[...bots].join(", ")} on ${env.NETWORK}`, { hold: env.HOLD_FILE });
await Promise.all(running);
