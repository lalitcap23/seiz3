import { erc20Abi, type Address } from "viem";
import { seiz3VaultAbi } from "@seiz3/shared/abis";
import { client, dep, log, owner, read, usd } from "./chain.js";
import { env } from "./env.js";
import type { MarketMaker } from "./marketMaker.js";

const REPEAT_MS = 30 * 60_000;
const lastSent = new Map<string, number>();

/** Posts `text` to ALERT_WEBHOOK_URL (Discord `content` / Slack `text`), at most every 30 minutes per alert. */
async function alert(key: string, text: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < REPEAT_MS) return;
  lastSent.set(key, now);
  log("alerts", text, { key });
  if (env.ALERT_WEBHOOK_URL === undefined) return;
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Seiz3 ${env.NETWORK}: ${text}`, text: `Seiz3 ${env.NETWORK}: ${text}` }),
  }).catch((error: unknown) => log("alerts", "webhook failed", { error: String(error) }));
}

const usd6 = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * What runs out on testnet and only a person can refill: the vault's idle USDC (it pays each liquidation's repayment),
 * its HyperCore margin (testnet's deposit contract loses funds, so a top-up is a manual HyperCore send), the market
 * maker's margin, the deployer's USDC and HYPE (rebalances, oracle updates), and the faucet.
 */
export async function checkAlerts(mm: MarketMaker | null): Promise<void> {
  const [idle, shortfall, coreUsdc] = await Promise.all([
    read<bigint>(dep.usdc, erc20Abi, "balanceOf", [dep.vault]),
    read<bigint>(dep.vault, seiz3VaultAbi, "marginShortfall"),
    read<bigint>(dep.vault, seiz3VaultAbi, "coreUsdc"),
  ]);
  if (idle < usd6(env.ALERT_IDLE_USDC)) {
    await alert("vault-idle", `vault idle USDC ${usd(idle)}: liquidations stop once it can't cover a repayment (fund-vault)`);
  }
  if (shortfall > 0n) {
    await alert("vault-margin", `vault short on HyperCore margin by ${usd(shortfall)} (Core value ${usd(coreUsdc)}): send USDC on HyperCore, then sweep`);
  } else if (coreUsdc < usd6(env.ALERT_CORE_USDC)) {
    await alert("vault-core", `vault HyperCore USDC ${usd(coreUsdc)}: new shorts need margin`);
  }

  if (owner !== null) {
    const [hype, usdc] = await Promise.all([
      client.getBalance({ address: owner.address }),
      read<bigint>(dep.usdc, erc20Abi, "balanceOf", [owner.address]),
    ]);
    if (hype < BigInt(Math.round(env.ALERT_DEPLOYER_HYPE * 1e18))) {
      await alert("deployer-hype", `deployer HYPE ${(Number(hype) / 1e18).toFixed(4)}: oracle and pool bots stop when it runs out`);
    }
    if (usdc < usd6(env.MIN_REBALANCER_USDC)) await alert("deployer-usdc", `deployer USDC ${usd(usdc)}: pool rebalances up will fail`);
  }

  if (dep.faucet !== undefined) {
    const faucet = dep.faucet as Address;
    const [nvdax, hype] = await Promise.all([
      read<bigint>(dep.nvdax, erc20Abi, "balanceOf", [faucet]),
      client.getBalance({ address: faucet }),
    ]);
    if (nvdax < 10n ** 18n) await alert("faucet-nvdax", `faucet NVDAx ${(Number(nvdax) / 1e18).toFixed(2)}: fund-faucet`);
    if (hype < 10n ** 16n) await alert("faucet-hype", `faucet HYPE ${(Number(hype) / 1e18).toFixed(4)}: new testers can't pay gas`);
  }

  if (mm !== null) {
    const a = await mm.account();
    if (a.free < env.ALERT_MM_USDC) {
      await alert("mm-margin", `market maker has $${a.free.toFixed(2)} free margin (position ${a.szi} NVDA): hedges stop filling without it`);
    }
  }
}
