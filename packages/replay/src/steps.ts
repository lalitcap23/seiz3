import { erc20Abi, maxUint256, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import {
  afterbellHookAbi,
  afterbellVaultAbi,
  demoOracleAbi,
  iMorphoAbi,
  mockNvdAxAbi,
  naiveLiquidatorAbi,
  poolSeederAbi,
  poolSwapTestAbi,
  riskParamsAbi,
} from "@afterbell/shared/abis";
import {
  extsloadAbi,
  poolSlots,
  priceLimit,
  slot0SqrtPrice,
  sqrtPriceAt,
  usdcPerNvdaxAt,
  type MarketName,
} from "@afterbell/shared";
import {
  borrowerOf,
  bots,
  coreOracleUsd6,
  dep,
  env,
  forgeScript,
  keeper,
  local,
  localChain,
  nvda,
  read,
  run,
  owner,
  send,
  sleep,
  usd,
  writeDeployment,
} from "./context.js";

const MARKETS: readonly MarketName[] = ["A_naive", "B_conservative", "C_afterbell"];
/** Testnet setup's borrowers: A and C just under the 77% LLTV (the scene's 1.4% drop tips them over), B safe. */
const SHOW_LTV_BPS: Record<MarketName, bigint> = { A_naive: 7680n, B_conservative: 3000n, C_afterbell: 7680n };
const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const mockCoreAbi = parseAbi(["function setPx(uint64 px)"]);

// Morpho Blue's liquidation maths, as in packages/keeper/src/riskCalc.ts
const LIQUIDATION_CURSOR = 3n * 10n ** 17n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n;

function liquidationIncentiveFactor(lltv: bigint): bigint {
  const factor = (WAD * WAD) / (WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD);
  return factor < MAX_LIQUIDATION_INCENTIVE_FACTOR ? factor : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

/** Most collateral Morpho hands over for at most `repayable` USDC of repayment. */
function seizableFor(repayable: bigint, price: bigint, lltv: bigint): bigint {
  if (repayable <= 0n || price <= 0n) return 0n;
  return (((repayable * liquidationIncentiveFactor(lltv)) / WAD) * ORACLE_SCALE) / price;
}

/** A market's demo borrower as Morpho sees it, or null where the deployment has none (testnet's A and B). */
async function borrowerState(market: MarketName) {
  const d = dep();
  const borrower = d.borrowers.find((b) => b.label === market)?.address;
  if (borrower === undefined) return null;
  const id = d.markets[market].id;
  const lltv = BigInt(d.markets[market].lltv);
  const [totals, position, price] = await Promise.all([
    read<{ totalBorrowAssets: bigint; totalBorrowShares: bigint }>(d.morpho, iMorphoAbi, "market", [id]),
    read<{ borrowShares: bigint; collateral: bigint }>(d.morpho, iMorphoAbi, "position", [id, borrower]),
    read<bigint>(d.markets[market].oracle, demoOracleAbi, "price"),
  ]);
  const debt =
    position.borrowShares === 0n
      ? 0n
      : (position.borrowShares * (totals.totalBorrowAssets + 1n) + totals.totalBorrowShares + 1_000_000n - 1n) /
        (totals.totalBorrowShares + 1_000_000n);
  const value = (position.collateral * price) / ORACLE_SCALE;
  return {
    borrower,
    debt,
    collateral: position.collateral,
    price,
    lltv,
    ltv: value === 0n ? 0 : Number(debt) / Number(value),
    healthy: (value * lltv) / WAD >= debt,
  };
}

async function report(market: MarketName) {
  const s = await borrowerState(market);
  if (s === null) return console.log(`  ${market.padEnd(15)} no borrower`);
  console.log(
    `  ${market.padEnd(15)} debt ${usd(s.debt)}, collateral ${nvda(s.collateral)}, LTV ${(s.ltv * 100).toFixed(1)}% ` +
      `of ${(Number(s.lltv) / 1e16).toFixed(1)}% → ${s.healthy ? "healthy" : "LIQUIDATABLE"}`,
  );
}

async function vaultState() {
  const d = dep();
  const [inventory, confirmedShort, pending] = await Promise.all([
    read<bigint>(d.vault, afterbellVaultAbi, "inventory"),
    read<bigint>(d.vault, afterbellVaultAbi, "confirmedShort"),
    read<readonly [bigint, bigint, bigint, number]>(d.vault, afterbellVaultAbi, "pendingHedge"),
  ]);
  return { inventory, confirmedShort, pendingDelta: pending[0] };
}

/** AfterbellHook.quote(): what one buy can take from the vault right now, at what ask. */
async function hookQuote() {
  const hook = dep().hook;
  if (hook === undefined) throw new Error("no hook in the deployment file: redeploy with Deploy.s.sol");
  const [capacity, ask, fee, open] = await read<readonly [bigint, bigint, number, boolean]>(hook, afterbellHookAbi, "quote");
  return { capacity, ask, fee: Number(fee), open };
}

async function vaultPoolSqrtPrice() {
  const d = dep();
  return slot0SqrtPrice(await read<Hex>(d.poolManager, extsloadAbi, "extsload", [poolSlots(d.poolKey).slot0]));
}

function localOnly(step: string) {
  if (!local) throw new Error(`${step} is local only: on testnet use scripts/testnet-stack.sh`);
}

/** Each step is one presenter click. Same order every run so the 3-minute demo is deterministic. */
export const STEPS = {
  /**
   * Run once before judging. Local: chain, vault, markets, lenders, borrowers, thin pool, anvil snapshot.
   * Testnet (no snapshots, so once per show): oracles onto HyperCore's price, lenders topped up, the deployer opens a
   * fresh borrower in each market, and the keeper waits for the market C click.
   */
  setup: async () => {
    if (local) return run("scripts/local-stack.sh", ["demo"]);
    const d = dep();
    const core = await coreOracleUsd6();
    const collateral = BigInt(Math.round(env.SHOW_NVDAX * 1e6)) * 10n ** 12n;
    keeper.hold();
    await send(d.nvdax, mockNvdAxAbi, "mint", [owner.address, collateral * BigInt(MARKETS.length)]);
    for (const token of [d.usdc, d.nvdax] as Address[]) await send(token, erc20Abi, "approve", [d.morpho, maxUint256]);
    for (const m of MARKETS) {
      const { id, oracle } = d.markets[m];
      await send(oracle, demoOracleAbi, "setPrice", [core * 10n ** 18n]);
      const params = await read(d.morpho, iMorphoAbi, "idToMarketParams", [id]);
      const debt = (((collateral * core) / WAD) * SHOW_LTV_BPS[m]) / 10_000n;
      const [supplied, , borrowed] = await read<readonly bigint[]>(d.morpho, iMorphoAbi, "market", [id]);
      const free = (supplied ?? 0n) - (borrowed ?? 0n);
      if (free < debt) await send(d.morpho, iMorphoAbi, "supply", [params, debt - free + 1_000_000n, 0n, owner.address, "0x"]);
      await send(d.morpho, iMorphoAbi, "supplyCollateral", [params, collateral, owner.address, "0x"]);
      await send(d.morpho, iMorphoAbi, "borrow", [params, debt, 0n, owner.address, owner.address]);
    }
    writeDeployment({
      borrowers: MARKETS.map((label) => ({ address: owner.address, label })),
      demo: { borrowPriceUsd6: core.toString() },
    });
    console.log(`borrowers open at ${usd(core)} with ${nvda(collateral)} each; keeper held until marketC`);
    for (const m of MARKETS) await report(m);
  },

  /** Between runs (local): rewind anvil to the snapshot setup took, keeper held again. */
  reset: async () => {
    localOnly("reset");
    await run("scripts/local-stack.sh", ["reset"]);
  },

  /** Scene: the weekend gap. All three markets' oracles drop at once (and HyperCore's, on the local stack). */
  scene: async () => {
    const d = dep();
    // On testnet HyperCore's oracle is real, and the vault only liquidates within 1.5% of it.
    const drop = local ? BigInt(Math.round(env.DROP_USD * 1e6)) : ((await coreOracleUsd6()) * 9_860n) / 10_000n;
    keeper.hold();
    if (!local) bots.hold();
    if (local) await send(localChain().core, mockCoreAbi, "setPx", [drop / 10n ** BigInt(d.hypercore.szDecimals)]);
    for (const m of MARKETS) await send(d.markets[m].oracle, demoOracleAbi, "setPrice", [drop * 10n ** 18n]);
    console.log(`NVDA ${usd(drop)} on all three markets${local ? " and on HyperCore" : ""}`);
    for (const m of MARKETS) await report(m);
  },

  /** Market A: NaiveLiquidator seizes the collateral and dumps it into the thin pool; the gap is bad debt. */
  marketA: async () => {
    const d = dep();
    if (d.naiveLiquidator === undefined) throw new Error("no naiveLiquidator in the deployment file");
    const s = await borrowerState("A_naive");
    if (s === null) throw new Error("no A_naive borrower: run setup first");
    if (s.healthy) throw new Error("market A's borrower is still healthy: run scene first");
    // borrowAssets is rounded up and Morpho's toAssetsDown is at most 1 lower
    const cap = seizableFor(s.debt - 1n, s.price, s.lltv);
    const seized = cap < s.collateral ? cap : s.collateral;
    const params = await read(d.morpho, iMorphoAbi, "idToMarketParams", [d.markets.A_naive.id]);
    const receipt = await send(d.naiveLiquidator, naiveLiquidatorAbi, "liquidate", [params, borrowerOf("A_naive"), seized]);
    const [event] = parseEventLogs({ abi: naiveLiquidatorAbi, eventName: "Shortfall", logs: receipt.logs });
    if (event === undefined) throw new Error("no Shortfall event");
    const { repaid, proceeds, shortfall } = event.args;
    console.log(`seized ${nvda(seized)} and dumped it into the thin pool for ${usd(proceeds)}`);
    console.log(`repaid ${usd(repaid)}: ${usd(shortfall)} short, the bad debt market A's lenders would have eaten`);
  },

  /** Market B: nothing to liquidate. The low LLTV kept the borrower healthy, at the price of a ~40% borrow limit. */
  marketB: async () => {
    await report("B_conservative");
  },

  /** Market C: the keeper is released; it liquidates through the vault, which shorts on HyperCore, then syncs. */
  marketC: async () => {
    const d = dep();
    keeper.release();
    console.log("keeper released: liquidate → short on HyperCore → syncHedge");
    const scale = 10n ** BigInt(18 - d.hypercore.szDecimals);
    const started = Date.now();
    let liquidated = false;
    let warned = false;
    while (Date.now() - started < 90_000) {
      const v = await vaultState();
      if (!liquidated && v.inventory > 0n) {
        liquidated = true;
        console.log(`liquidated: the vault holds ${nvda(v.inventory)}; hedge of ${v.pendingDelta} sent to HyperCore`);
      }
      if (liquidated && v.pendingDelta === 0n && v.confirmedShort === -(v.inventory / scale)) {
        console.log(`hedged: short ${v.confirmedShort} on HyperCore, confirmed by syncHedge, 100% hedged`);
        return;
      }
      if (!liquidated && !warned && Date.now() - started > 20_000) {
        warned = true;
        console.warn("nothing yet: is the keeper running (scripts/local-stack.sh keeper), with tick and the risk engine?");
      }
      await sleep(1000);
    }
    throw new Error("market C not hedged within 90 s: check the keeper's log");
  },

  /**
   * Weekend buyers (between marketC and monday): people buy NVDAx on the vault's pool, and the hook fills them from the
   * vault's hedged stock at its ask, off the curve. Each fill queues the matching buy-back on HyperCore, and the next one
   * waits for the keeper's syncHedge. Needs the keeper running, as for marketC.
   */
  buyers: async () => {
    const d = dep();
    if (d.swapRouter === undefined) throw new Error("no swapRouter in the deployment file: redeploy with Deploy.s.sol");
    const scale = 10n ** BigInt(18 - d.hypercore.szDecimals);
    const nvdax0 = d.poolKey.currency0.toLowerCase() === d.nvdax.toLowerCase();
    const buyDir = !nvdax0; // pay USDC in
    const swap = (amountSpecified: bigint, limit: bigint) =>
      send(d.swapRouter!, poolSwapTestAbi, "swap", [
        d.poolKey,
        { zeroForOne: buyDir, amountSpecified, sqrtPriceLimitX96: limit },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ]);
    await send(d.usdc, erc20Abi, "approve", [d.swapRouter, maxUint256]);

    let q = await hookQuote();
    const pool = usdcPerNvdaxAt(await vaultPoolSqrtPrice(), nvdax0);
    console.log(
      `vault's ask ${usd(q.ask)} (HyperCore oracle + ${q.open ? "market" : "after-hours"} spread); pool at ${usd(pool)}; ` +
        `${q.open ? "market" : "after-hours"} fee on the curve ${(q.fee / 10_000).toFixed(2)}%`,
    );
    if (pool < q.ask) {
      // the hook only sells at its ask when the pool trades at or above it: weekend buyers bid the token up first
      await swap(-(10n ** 30n), sqrtPriceAt((q.ask * 10_050n) / 10_000n, nvdax0));
      console.log(`weekend buyers bid the pool up to ${usd(usdcPerNvdaxAt(await vaultPoolSqrtPrice(), nvdax0))}`);
    }

    const fills = env.BUYERS;
    for (let i = 0; i < fills; i++) {
      const started = Date.now();
      while ((q = await hookQuote()).capacity === 0n) {
        const v = await vaultState();
        if (v.inventory < scale) return console.log("nothing left to sell: the vault is flat");
        if (Date.now() - started > 60_000) throw new Error("the hook stayed closed for 60 s: is the keeper syncing?");
        await sleep(1000);
      }
      const before = (await vaultState()).inventory;
      await swap(q.capacity, priceLimit(await vaultPoolSqrtPrice(), buyDir, 500)); // exact out: one full fill
      const v = await vaultState();
      console.log(
        `buyer ${i + 1}: took ${nvda(before - v.inventory)} from the vault at ${usd(q.ask)}; ` +
          `buy-back of ${v.pendingDelta} sent to HyperCore`,
      );
    }
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      const v = await vaultState();
      if (v.pendingDelta === 0n) {
        return console.log(`hedged again: ${nvda(v.inventory)} held, short ${v.confirmedShort} on HyperCore`);
      }
      await sleep(1000);
    }
    throw new Error("the last buy-back wasn't confirmed within 60 s: check the keeper's log");
  },

  /** Monday: the arbitrage puts the pool back on the oracle, deep liquidity arrives, the market opens, the keeper unwinds. */
  monday: async () => {
    const d = dep();
    if (d.poolSeeder === undefined) throw new Error("no poolSeeder in the deployment file");
    const oracle = await coreOracleUsd6();
    const nvdaxIsCurrency0 = d.poolKey.currency0.toLowerCase() === d.nvdax.toLowerCase(); // same tokens in both pools
    for (const token of [d.usdc, d.nvdax] as Address[]) {
      await send(token, erc20Abi, "approve", [d.poolSeeder, maxUint256]);
    }
    // testnet: market A dumped into its own thin pool, and the bots keep the vault's deep pool on the oracle
    const dumped = d.thinPoolKey ?? d.poolKey;
    await send(d.poolSeeder, poolSeederAbi, "swapToPrice", [dumped, sqrtPriceAt(oracle, nvdaxIsCurrency0)]);
    console.log(`arbitrage: ${d.thinPoolKey ? "thin " : ""}pool back on HyperCore's ${usd(oracle)}`);
    if (local && d.thinPoolKey) {
      // locally nothing else arbitrages the vault's own pool (testnet's bots do); bringing it down from Friday's
      // price sells NVDAx into it, so the owner mints the mock stock that takes
      await send(d.nvdax, mockNvdAxAbi, "mint", [owner.address, 1_000n * WAD]);
      await send(d.poolSeeder, poolSeederAbi, "swapToPrice", [d.poolKey, sqrtPriceAt(oracle, nvdaxIsCurrency0)]);
      console.log(`arbitrage: the vault's pool back on ${usd(oracle)}`);
    }

    const depth = env.MONDAY_USDC ?? (local ? 1_000_000 : undefined);
    if (depth !== undefined) {
      await forgeScript("SeedPool.s.sol", { THIN: "false", USDC_AMOUNT: String(BigInt(Math.round(depth * 1e6))) });
      console.log(`deep liquidity: ${usd(BigInt(Math.round(depth * 1e6)))} around the oracle`);
    }
    if (!local) {
      bots.release();
      console.log("bots released: the oracles follow HyperCore again, the deep pool stays on it");
    }

    await send(d.riskParams, riskParamsAbi, "setMarketOpen", [true]);
    keeper.release();
    console.log(
      d.hook
        ? "market open: buyers keep filling from the vault through the hook, and the keeper pushes the rest into the pool"
        : "market open: the keeper unwinds, selling NVDAx into the pool and buying the short back",
    );

    const started = Date.now();
    let last = -1n;
    while (Date.now() - started < 120_000) {
      const v = await vaultState();
      if (v.inventory !== last) {
        console.log(`  inventory ${nvda(v.inventory)}, short ${v.confirmedShort}`);
        last = v.inventory;
      }
      if (v.inventory === 0n && v.confirmedShort === 0n) return console.log("unwound: no stock, no short");
      await sleep(1000);
    }
    console.log("still unwinding after 2 minutes; the dashboard keeps showing the loop");
  },
} as const;

export type StepName = keyof typeof STEPS;
