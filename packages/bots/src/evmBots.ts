import { erc20Abi, maxUint256, parseEventLogs, type Address } from "viem";
import {
  seiz3HookRemoteAbi,
  seiz3VaultRemoteAbi,
  demoOracleAbi,
  mockNvdAxAbi,
  poolSeederAbi,
  poolSwapTestAbi,
  riskParamsAbi,
} from "@seiz3/shared/abis";
import { nvdaxIsCurrency0, sqrtPriceAt, usdcPerNvdaxAt, type MarketName } from "@seiz3/shared";
import { client, coreOracleUsd6, dep, diffBps, log, owner, poolState, read, send, usd } from "./chain.js";
import { env } from "./env.js";

const MARKETS: readonly MarketName[] = ["A_naive", "B_conservative", "C_seiz3"];
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
  if (sqrtPriceX96 === 0n || liquidity === 0n) return; // not seeded yet (scripts/base-stack.sh sepolia seed deep)
  const pool = usdcPerNvdaxAt(sqrtPriceX96, nvdax0);
  const target = await poolTarget(core);
  const gap = diffBps(pool, target);
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
  if (pool > target) {
    // selling NVDAx into the pool: keep some on hand (the deployer owns MockNVDAx)
    const topUp = BigInt(Math.round(env.NVDAX_TOPUP * 1e6)) * 10n ** 12n;
    if ((await read<bigint>(dep.nvdax, erc20Abi, "balanceOf", [me])) < topUp) {
      await send(dep.nvdax, mockNvdAxAbi, "mint", [me, topUp]);
    }
  } else {
    const usdc = await read<bigint>(dep.usdc, erc20Abi, "balanceOf", [me]);
    if (usdc < BigInt(env.MIN_REBALANCER_USDC * 1e6)) await recycleFromVault(me, usdc);
  }
  await send(seeder, poolSeederAbi, "swapToPrice", [dep.poolKey, sqrtPriceAt(target, nvdax0)]);
  log("pool", `pool ${usd(pool)} → ${usd(target)} (${gap} bps off${target === core ? "" : ", held over the hook's ask"})`);
}

/**
 * Where the pool should trade: HyperCore's oracle, the arbitrage a live market would do. With POOL_ABOVE_ASK_BPS set
 * and stock in the vault, just over the hook's ask instead, so any buyer (a bot or a person on /try) is filled from the
 * vault through the hook. Moving the pool up there starts below the ask, where the hook sells nothing, so the move
 * itself never takes stock from the vault; and it stays inside the vault's oracle band, so unwinds still run.
 */
async function poolTarget(core: bigint): Promise<bigint> {
  if (env.POOL_ABOVE_ASK_BPS === undefined || dep.hook === undefined) return core;
  if ((await read<bigint>(dep.vault, seiz3VaultRemoteAbi, "inventory")) === 0n) return core;
  const [, ask] = await read<readonly [bigint, bigint, number, boolean]>(dep.hook, seiz3HookRemoteAbi, "quote");
  return (ask * (BPS + BigInt(env.POOL_ABOVE_ASK_BPS))) / BPS;
}

/** Redeem some of the deployer's own LP shares for the next rebalance, never below the vault's floor. */
async function recycleFromVault(me: Address, usdc: bigint): Promise<void> {
  const want = BigInt(Math.round(env.USDC_TOPUP * 1e6));
  const floor = BigInt(Math.round(env.VAULT_FLOOR_USDC * 1e6));
  const instant = await read<bigint>(dep.vault, seiz3VaultRemoteAbi, "instantLiquidity");
  if (instant < floor + want) {
    log("pool", `deployer has only ${usd(usdc)} and the vault ${usd(instant)} to spare: refill the deployer by hand`);
    return;
  }
  const shares = await read<bigint>(dep.vault, seiz3VaultRemoteAbi, "convertToShares", [want]);
  if (shares > (await read<bigint>(dep.vault, seiz3VaultRemoteAbi, "maxRedeem", [me]))) {
    log("pool", `deployer has only ${usd(usdc)} and not enough vault shares left: refill it by hand`);
    return;
  }
  await send(dep.vault, seiz3VaultRemoteAbi, "requestWithdraw", [shares]);
  log("pool", `deployer ${usd(usdc)} → redeemed ${usd(want)} of its vault shares for rebalancing`);
}

const BPS = 10_000n;
let lastBuyAt = 0;
const allowed = new Set<string>();

async function approveOnce(token: Address, spender: Address): Promise<void> {
  const key = `${token}:${spender}`;
  if (allowed.has(key)) return;
  if ((await read<bigint>(token, erc20Abi, "allowance", [owner!.address, spender])) < maxUint256 / 2n) {
    await send(token, erc20Abi, "approve", [spender, maxUint256]);
  }
  allowed.add(key);
}

/**
 * A demo buyer on the vault's pool, so a round shows both ways the vault sells: the keeper's unwindStep pushes stock
 * into the Uniswap curve, and a buyer is filled straight from the vault by Seiz3Hook (InventoryFill), at HyperCore's
 * oracle plus the spread. While the vault holds stock and no buy-back is in flight, every BUYER_INTERVAL_MS it buys
 * BUYER_USDC of NVDAx. The hook only sells while the pool trades at or above its ask, and the pool bot holds the pool
 * on the oracle, so the buyer first bids the curve just past the ask (buy pressure, through PoolSeeder), then buys
 * through the public swap router. The pool bot sells the curve back to the oracle on its next round.
 */
/** BUYER_EACH_LIQUIDATION: when the vault's current stock arrived (block time), and the inventory seen last round. */
let stockSince: bigint | null = null;
let lastInventory = 0n;

export async function buyFromVault(): Promise<void> {
  const hook = dep.hook;
  const router = dep.swapRouter;
  if (hook === undefined || router === undefined) return;
  const [inventory, pending, paused, lastUnwindAt, cooldown, block] = await Promise.all([
    read<bigint>(dep.vault, seiz3VaultRemoteAbi, "inventory"),
    read<readonly [bigint, bigint, bigint, number]>(dep.vault, seiz3VaultRemoteAbi, "pendingHedge"),
    read<boolean>(dep.vault, seiz3VaultRemoteAbi, "paused"),
    read<bigint>(dep.vault, seiz3VaultRemoteAbi, "lastUnwindAt"),
    read<number>(dep.riskParams, riskParamsAbi, "cooldown"),
    client.getBlock(),
  ]);
  if (inventory === 0n) stockSince = null;
  else if (inventory > lastInventory) stockSince = block.timestamp; // a liquidation handed the vault new stock
  lastInventory = inventory;
  // BUYER_EACH_LIQUIDATION: the first buy from each liquidation's stock goes out at once, inside the keeper's buyer
  // window (BUYER_WINDOW_SEC), so every liquidation sells to a buyer through the hook before anything is pushed
  const firstFromNewStock = env.BUYER_EACH_LIQUIDATION && stockSince !== null && lastUnwindAt < stockSince;
  if (!firstFromNewStock && Date.now() - lastBuyAt < env.BUYER_INTERVAL_MS) return;
  // nothing to sell, or a buy-back still in flight: the hook wouldn't sell either
  if (inventory === 0n || pending[0] !== 0n || paused) return;
  // the keeper's next sale is due soon: wait for the window after it (checked again next round, a few seconds on)
  if (!firstFromNewStock && Number(lastUnwindAt) + Number(cooldown) - Number(block.timestamp) < env.BUYER_MIN_WINDOW_SEC) {
    return;
  }

  const amountIn = BigInt(Math.round(env.BUYER_USDC * 1e6));
  const me = owner!.address;
  if ((await read<bigint>(dep.usdc, erc20Abi, "balanceOf", [me])) < amountIn * 2n) {
    log("buyer", `deployer holds under ${usd(amountIn * 2n)} USDC: skipping (the pool bot recycles vault shares into USDC)`);
    lastBuyAt = Date.now();
    return;
  }
  const nvdax0 = nvdaxIsCurrency0(dep.poolKey, dep.nvdax);
  const [ready, ask] = await read<readonly [bigint, bigint, number, boolean]>(hook, seiz3HookRemoteAbi, "quote");
  await approveOnce(dep.usdc, dep.poolSeeder as Address);
  await approveOnce(dep.usdc, router);

  // 1. buy pressure: the curve just past the hook's ask, unless the pool already trades there (the hook can sell now:
  //    a push would itself be a buy the hook fills from the vault)
  if (ready === 0n) {
    await send(dep.poolSeeder as Address, poolSeederAbi, "swapToPrice", [
      dep.poolKey,
      sqrtPriceAt((ask * (BPS + BigInt(env.BUYER_PUSH_BPS))) / BPS, nvdax0),
    ]);
  }
  const [capacity] = await read<readonly [bigint, bigint, number, boolean]>(hook, seiz3HookRemoteAbi, "quote");
  lastBuyAt = Date.now();
  if (capacity === 0n) {
    log("buyer", "the hook has nothing to sell right now (a keeper unwind landed first): next round");
    return;
  }
  // 2. the buy: exact USDC in, filled from the vault's stock at the ask; anything over goes to the curve, capped 0.5% up
  const hash = await send(router, poolSwapTestAbi, "swap", [
    dep.poolKey,
    { zeroForOne: !nvdax0, amountSpecified: -amountIn, sqrtPriceLimitX96: sqrtPriceAt((ask * (BPS + 50n)) / BPS, nvdax0) },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
  ]);
  const receipt = await client.getTransactionReceipt({ hash });
  const [fill] = parseEventLogs({ abi: seiz3HookRemoteAbi, eventName: "InventoryFill", logs: receipt.logs });
  if (fill === undefined) {
    log("buyer", `bought on the curve, not from the vault (${hash})`);
    return;
  }
  log("buyer", `bought ${(Number(fill.args.nvdaxOut) / 1e18).toFixed(3)} NVDAx straight from the vault for ${usd(fill.args.usdcIn)} at the ${usd(fill.args.ask)} ask`, { tx: hash });
}

export { coreOracleUsd6 };
