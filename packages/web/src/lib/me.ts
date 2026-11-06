"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { afterbellVaultAbi, demoOracleAbi, faucetAbi, iMorphoAbi } from "@afterbell/shared/abis";
import {
  accruedTotalBorrow,
  debtOf,
  liquidationPriceUsd6,
  maxDebt,
} from "@afterbell/shared/morpho";
// subpaths, not the package root: Turbopack can't resolve the root's "./x.js" re-exports to TS sources
import {
  extsloadAbi,
  nvdaxIsCurrency0,
  poolSlots,
  slot0SqrtPrice,
  usdcPerNvdaxAt,
} from "@afterbell/shared/pool";
import { dep, publicClient } from "./chain";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO = "0x0000000000000000000000000000000000000000";
const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);
const irmAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }",
  "function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)",
]);

const marketId = dep.markets!.C_afterbell.id;

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface Me {
  hype: bigint;
  usdc: bigint;
  nvdax: bigint;
  allowance: {
    usdcMorpho: bigint;
    nvdaxMorpho: bigint;
    usdcVault: bigint;
    usdcRouter: bigint;
    nvdaxRouter: bigint;
  };
  market: {
    params: MarketParams;
    price: bigint; // Morpho 1e36 scale
    ratePerSec: bigint;
    liquidity: bigint; // USDC a borrower can take right now
  };
  position: {
    collateral: bigint;
    borrowShares: bigint;
    debt: bigint; // with interest Morpho hasn't booked yet
    maxDebt: bigint;
    ltv: number;
    liquidationPriceUsd6: bigint;
  };
  vault: {
    shares: bigint;
    value: bigint;
    maxRedeem: bigint;
    queued: bigint;
    queuedValue: bigint;
    sharePrice: number;
    instantLiquidity: bigint;
  };
  pool: { sqrtPriceX96: bigint; priceUsd6: bigint };
  nextDripAt: number;
  now: bigint;
}

/**
 * Everything the tester page shows for `me`, refreshed every 5 s and after each transaction: one multicall plus the
 * IRM rate. The browser shares the public RPC's ~100 requests a minute per IP, so no extra calls.
 */
export function useMe(me: Address | null) {
  return useQuery({
    queryKey: ["me", me],
    enabled: me !== null,
    refetchInterval: 5_000,
    queryFn: async (): Promise<Me> => {
      const who = me!;
      const slots = poolSlots(dep.poolKey);
      const r = await publicClient.multicall({
        allowFailure: false,
        multicallAddress: MULTICALL3,
        contracts: [
          { address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] },
          { address: dep.nvdax, abi: erc20Abi, functionName: "balanceOf", args: [who] },
          { address: dep.usdc, abi: erc20Abi, functionName: "allowance", args: [who, dep.morpho] },
          { address: dep.nvdax, abi: erc20Abi, functionName: "allowance", args: [who, dep.morpho] },
          { address: dep.usdc, abi: erc20Abi, functionName: "allowance", args: [who, dep.vault] },
          {
            address: dep.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [who, dep.swapRouter ?? ZERO],
          },
          {
            address: dep.nvdax,
            abi: erc20Abi,
            functionName: "allowance",
            args: [who, dep.swapRouter ?? ZERO],
          },
          {
            address: dep.morpho,
            abi: iMorphoAbi,
            functionName: "idToMarketParams",
            args: [marketId],
          },
          { address: dep.morpho, abi: iMorphoAbi, functionName: "market", args: [marketId] },
          { address: dep.morpho, abi: iMorphoAbi, functionName: "position", args: [marketId, who] },
          { address: dep.markets!.C_afterbell.oracle, abi: demoOracleAbi, functionName: "price" },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "balanceOf", args: [who] },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "maxRedeem", args: [who] },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "queued", args: [who] },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "totalAssets" },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "totalSupply" },
          { address: dep.vault, abi: afterbellVaultAbi, functionName: "instantLiquidity" },
          {
            address: dep.poolManager,
            abi: extsloadAbi,
            functionName: "extsload",
            args: [slots.slot0],
          },
          { address: MULTICALL3, abi: multicall3Abi, functionName: "getEthBalance", args: [who] },
          { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
          // no faucet on this network: the timestamp again keeps the result order fixed
          dep.faucet
            ? { address: dep.faucet, abi: faucetAbi, functionName: "nextDripAt", args: [who] }
            : { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
        ],
      });
      const [usdc, nvdax, aUM, aNM, aUV, aUR, aNR, paramsRaw, marketRaw, positionRaw, price] = r;
      const [
        shares,
        maxRedeem,
        queued,
        totalAssets,
        totalSupply,
        instantLiquidity,
        slot0,
        hype,
        timestamp,
        dripRaw,
      ] = r.slice(11) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        Hex,
        bigint,
        bigint,
        bigint,
      ];
      const nextDripAt = dep.faucet ? dripRaw : 0n;
      // IMorpho returns its structs as named objects
      const params: MarketParams = paramsRaw;
      const { irm, lltv } = params;
      const market = marketRaw;
      const { totalSupplyAssets, totalBorrowAssets, totalBorrowShares, lastUpdate } = market;
      const { borrowShares, collateral } = positionRaw;

      const ratePerSec =
        irm === ZERO
          ? 0n
          : await publicClient.readContract({
              address: irm,
              abi: irmAbi,
              functionName: "borrowRateView",
              args: [params, market],
            });
      const totalBorrow = accruedTotalBorrow(totalBorrowAssets, ratePerSec, timestamp - lastUpdate);
      const debt = debtOf(borrowShares, totalBorrow, totalBorrowShares);
      const limit = maxDebt(collateral, price as bigint, lltv);
      const value = collateral === 0n ? 0 : Number((collateral * (price as bigint)) / 10n ** 36n);
      const toAssets = (s: bigint) => (totalSupply === 0n ? 0n : (s * totalAssets) / totalSupply);
      const sqrtPriceX96 = slot0SqrtPrice(slot0);

      return {
        hype,
        usdc: usdc as bigint,
        nvdax: nvdax as bigint,
        allowance: {
          usdcMorpho: aUM as bigint,
          nvdaxMorpho: aNM as bigint,
          usdcVault: aUV as bigint,
          usdcRouter: aUR as bigint,
          nvdaxRouter: aNR as bigint,
        },
        market: {
          params,
          price: price as bigint,
          ratePerSec,
          liquidity: totalSupplyAssets - totalBorrow,
        },
        position: {
          collateral,
          borrowShares,
          debt,
          maxDebt: limit,
          ltv: value === 0 ? 0 : Number(debt) / value,
          liquidationPriceUsd6: liquidationPriceUsd6(collateral, debt, lltv),
        },
        vault: {
          shares,
          value: toAssets(shares),
          maxRedeem,
          queued,
          queuedValue: toAssets(queued),
          // shares carry 6 extra decimals (the vault's inflation guard)
          sharePrice: totalSupply === 0n ? 1 : (Number(totalAssets) / Number(totalSupply)) * 1e6,
          instantLiquidity,
        },
        pool: {
          sqrtPriceX96,
          priceUsd6: usdcPerNvdaxAt(sqrtPriceX96, nvdaxIsCurrency0(dep.poolKey, dep.nvdax)),
        },
        nextDripAt: Number(nextDripAt),
        now: timestamp,
      };
    },
  });
}
