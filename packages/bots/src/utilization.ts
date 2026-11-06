import { erc20Abi, maxUint256, parseAbi, type Address } from "viem";
import { demoOracleAbi, iMorphoAbi, mockNvdAxAbi } from "@afterbell/shared/abis";
import { dep, log, owner, read, send, usd } from "./chain.js";
import { env } from "./env.js";

/** The test USDC (RemoteInfra's MockUSDC) mints to anyone. */
const mintableAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const VIRTUAL_SHARES = 10n ** 6n; // Morpho's share offset
const SCALE = 10n ** 36n; // Morpho oracle price scale

interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

let approved = false;

/**
 * Market C at its rate model's target utilization, as a live Morpho market runs: Morpho's AdaptiveCurveIrm charges
 * ~4% APR at 90% and up to 4× that above it, but ~1% on an idle market, where a borrow at the limit takes over a
 * minute of interest to tip over. The deployer borrows the market's spare USDC down to UTIL_FREE_USDC of free
 * liquidity (what testers' borrows draw on), and repays when testers' borrows take it below that.
 *
 * The deployer's own loan stays at 50% LTV (it supplies NVDAx collateral as it borrows), far from the 77% LLTV, so
 * the keeper never liquidates it.
 */
export async function holdUtilization(): Promise<void> {
  if (env.UTIL_FREE_USDC === undefined) return;
  const target = BigInt(Math.round(env.UTIL_FREE_USDC * 1e6));
  const id = dep.markets.C_afterbell.id;
  const me = owner!.address;
  const [params, market, position] = await Promise.all([
    read<MarketParams>(dep.morpho, iMorphoAbi, "idToMarketParams", [id]),
    read<{ totalSupplyAssets: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint }>(
      dep.morpho,
      iMorphoAbi,
      "market",
      [id],
    ),
    read<{ borrowShares: bigint; collateral: bigint }>(dep.morpho, iMorphoAbi, "position", [id, me]),
  ]);
  const free = market.totalSupplyAssets - market.totalBorrowAssets;
  const gap = free - target; // > 0: spare liquidity to borrow; < 0: testers need it back
  if (gap < target / 4n && gap > -target / 4n) return; // ±25%: no churn on interest or one small move
  const debt =
    market.totalBorrowShares === 0n
      ? 0n
      : (position.borrowShares * (market.totalBorrowAssets + 1n)) / (market.totalBorrowShares + VIRTUAL_SHARES);
  if (!approved) {
    const allowance = await read<bigint>(dep.usdc, erc20Abi, "allowance", [me, dep.morpho]);
    if (allowance < maxUint256 / 2n) await send(dep.usdc, erc20Abi, "approve", [dep.morpho, maxUint256]);
    const nvdaxAllowance = await read<bigint>(dep.nvdax, erc20Abi, "allowance", [me, dep.morpho]);
    if (nvdaxAllowance < maxUint256 / 2n) await send(dep.nvdax, erc20Abi, "approve", [dep.morpho, maxUint256]);
    approved = true;
  }

  if (gap > 0n) {
    // collateral for 50% LTV after this borrow: debt = collateral × price / 1e36 × 0.5
    const price = await read<bigint>(params.oracle, demoOracleAbi, "price");
    const needed = ((debt + gap) * 2n * SCALE) / price;
    if (needed > position.collateral) {
      const add = needed - position.collateral;
      await send(dep.nvdax, mockNvdAxAbi, "mint", [me, add]);
      await send(dep.morpho, iMorphoAbi, "supplyCollateral", [params, add, me, "0x"]);
    }
    await send(dep.morpho, iMorphoAbi, "borrow", [params, gap, 0n, me, me]);
    log("util", `borrowed ${usd(gap)}: market C ${usd(target)} free, ${utilization(market, gap)} utilized`);
    return;
  }
  const owed = -gap < debt ? -gap : debt;
  if (owed === 0n) return;
  const balance = await read<bigint>(dep.usdc, erc20Abi, "balanceOf", [me]);
  if (balance < owed) await send(dep.usdc, mintableAbi, "mint", [me, owed - balance]);
  // all of it by shares when the whole loan goes (no dust left behind), else by assets
  await send(
    dep.morpho,
    iMorphoAbi,
    "repay",
    owed === debt ? [params, 0n, position.borrowShares, me, "0x"] : [params, owed, 0n, me, "0x"],
  );
  log("util", `repaid ${usd(owed)}: market C back to ${usd(target)} free, ${utilization(market, -owed)} utilized`);
}

function utilization(m: { totalSupplyAssets: bigint; totalBorrowAssets: bigint }, borrowed: bigint): string {
  if (m.totalSupplyAssets === 0n) return "0%";
  return `${((Number(m.totalBorrowAssets + borrowed) / Number(m.totalSupplyAssets)) * 100).toFixed(1)}%`;
}
