import { getDeployment, makePublicClient, makeWalletClient, rpcUrlFor } from "@afterbell/shared";
import { env } from "./env.js";
import { buildActions } from "./actions.js";

const replay = process.argv.includes("--replay");
const deployment = getDeployment(env.NETWORK);
const rpcUrl = rpcUrlFor(env.NETWORK);
const publicClient = makePublicClient(env.NETWORK, rpcUrl);
const wallet = makeWalletClient(env.NETWORK, env.KEEPER_PRIVATE_KEY, rpcUrl);

let fakeNow: number | undefined; // advanced by the replay script in --replay mode
const actions = buildActions({ vault: deployment.vault, now: () => fakeNow ?? Date.now() });

/** One action per tick, in priority order. Never two txs in flight. */
async function tick() {
  for (const a of actions) {
    try {
      if (!(await a.check())) continue;
      const hash = await a.run();
      console.log(`[keeper] ${a.name} → ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      console.error(`[keeper] ${a.name} failed`, err);
    }
    return;
  }
}

console.log(
  `[keeper] ${env.NETWORK} vault=${deployment.vault} signer=${wallet.account.address} replay=${replay}`,
);

if (replay) {
  // TODO: expose a tiny control channel (stdin or HTTP) so the replay script can set fakeNow and trigger ticks
  process.stdin.on("data", async () => {
    fakeNow = Date.now();
    await tick();
  });
} else {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    await tick().finally(() => (busy = false));
  }, env.KEEPER_TICK_MS);
}
