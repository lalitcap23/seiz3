import { erc20Abi, maxUint256, type Address } from "viem";
import { afterbellVaultAbi, demoOracleAbi, mockNvdAxAbi, poolSeederAbi } from "@afterbell/shared/abis";
import { nvdaxIsCurrency0, sqrtPriceAt, usdcPerNvdaxAt, type MarketName } from "@afterbell/shared";
import { coreOracleUsd6, dep, diffBps, log, owner, poolState, read, send, usd } from "./chain.js";
import { env } from "./env.js";

const MARKETS: readonly MarketName[] = ["A_naive", "B_conservative", "C_afterbell"];
const MORPHO_SCALE = 10n ** 18n; // DemoOracle price = usd6 × 1e18

/**
 * Markets A, B and C follow HyperCore's oracle. The vault only liquidates within 1.5% of it, and testnet NVDA moves
 * every day, so without this market C drifts out of the band and nobody gets liquidated at all. A move down is what
 * liquidates a tester who borrowed at the limit, as it would on a live market.
 */
export async function followOracles(core: bigint): Promise<void> {
  for (const m of MARKETS) {
    const oracle = dep.markets[m].oracle;
    const price = (await read<bigint>(oracle, demoOracleAbi, "price")) / MORPHO_SCALE;
    if (diffBps(price, core) <= env.FOLLOW_BPS) continue;
    await send(oracle, demoOracleAbi, "setPrice", [core * MORPHO_SCALE]);
    log("oracle", `${m} ${usd(price)} → ${usd(core)}`);
  }
}

let approved = false;

/**
 * The vault's pool back on HyperCore's oracle, the arbitrage a live market would get for free: the vault only unwinds
 * while the pool is within 1.5% of the oracle, and each unwind chunk or tester swap pushes it away. Paid by the
 * deployer through PoolSeeder: USDC when the pool is under the oracle, NVDAx (minted) when over.
 */
export async function rebalancePool(core: bigint): Promise<void> {
  const nvdax0 = nvdaxIsCurrency0(dep.poolKey, dep.nvdax);
  const { sqrtPriceX96, liquidity } = await poolState(dep.poolKey);
  if (sqrtPriceX96 === 0n || liquidity === 0n) return; // not seeded yet (scripts/testnet-stack.sh seed deep)
  const pool = usdcPerNvdaxAt(sqrtPriceX96, nvdax0);
  const gap = diffBps(pool, core);
  if (gap <= env.REBALANCE_BPS) return;

  const seeder = dep.poolSeeder as Address;
  const me = owner!.address;
  if (!approved) {
    for (const token of [dep.usdc, dep.nvdax]) {
      const allowance = await read<bigint>(token, erc20Abi, "allowance", [me, seeder]);
      if (allowance < maxUint256 / 2n) await send(token, erc20Abi, "approve", [seeder, maxUint256]);
    }
    approved = true;
  }
  if (pool > core) {
    // selling NVDAx into the pool: keep some on hand (the deployer owns MockNVDAx)
    const topUp = BigInt(Math.round(env.NVDAX_TOPUP * 1e6)) * 10n ** 12n;
    if ((await read<bigint>(dep.nvdax, erc20Abi, "balanceOf", [me])) < topUp) {
      await send(dep.nvdax, mockNvdAxAbi, "mint", [me, topUp]);
    }
  } else {
    const usdc = await read<bigint>(dep.usdc, erc20Abi, "balanceOf", [me]);
    if (usdc < BigInt(env.MIN_REBALANCER_USDC * 1e6)) await recycleFromVault(me, usdc);
  }
  await send(seeder, poolSeederAbi, "swapToPrice", [dep.poolKey, sqrtPriceAt(core, nvdax0)]);
  log("pool", `pool ${usd(pool)} → ${usd(core)} (${gap} bps off)`);
}

/** Redeem some of the deployer's own LP shares for the next rebalance, never below the vault's floor. */
async function recycleFromVault(me: Address, usdc: bigint): Promise<void> {
  const want = BigInt(Math.round(env.USDC_TOPUP * 1e6));
  const floor = BigInt(Math.round(env.VAULT_FLOOR_USDC * 1e6));
  const instant = await read<bigint>(dep.vault, afterbellVaultAbi, "instantLiquidity");
  if (instant < floor + want) {
    log("pool", `deployer has only ${usd(usdc)} and the vault ${usd(instant)} to spare: refill the deployer by hand`);
    return;
  }
  const shares = await read<bigint>(dep.vault, afterbellVaultAbi, "convertToShares", [want]);
  if (shares > (await read<bigint>(dep.vault, afterbellVaultAbi, "maxRedeem", [me]))) {
    log("pool", `deployer has only ${usd(usdc)} and not enough vault shares left: refill it by hand`);
    return;
  }
  await send(dep.vault, afterbellVaultAbi, "requestWithdraw", [shares]);
  log("pool", `deployer ${usd(usdc)} → redeemed ${usd(want)} of its vault shares for rebalancing`);
}

export { coreOracleUsd6 };
