"use client";

import { useState } from "react";
import { erc20Abi, maxUint256 } from "viem";
import { poolSwapTestAbi } from "@afterbell/shared/abis";
import { priceLimit } from "@afterbell/shared/pool";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, AmountInput, Card, Rows, fmt, useAmount } from "./ui";

const SLIPPAGE_BPS = 100;
const FEE = 0.003;

/** USDC ↔ NVDAx on the vault's Uniswap v4 pool, through v4-core's PoolSwapTest router. */
export function SwapCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const [buy, setBuy] = useState(true); // buy NVDAx with USDC
  const amount = useAmount(buy ? 6 : 18);
  if (!dep.swapRouter) return <Card title="Swap · Uniswap v4" hint="No swap router on this network yet." />;
  if (!address || !me) return <Card title="Swap · Uniswap v4" hint="Connect a wallet first." />;

  const router = dep.swapRouter;
  const tokenIn = buy ? dep.usdc : dep.nvdax;
  const zeroForOne = dep.poolKey.currency0.toLowerCase() === tokenIn.toLowerCase();
  const price = Number(me.pool.priceUsd6) / 1e6;
  const inHuman = amount.value === null ? 0 : Number(amount.value) / 10 ** (buy ? 6 : 18);
  const estimate = price === 0 ? 0 : (buy ? inHuman / price : inHuman * price) * (1 - FEE);

  async function swap() {
    const amountIn = amount.value;
    if (amountIn === null || amountIn === 0n) return;
    const allowance = buy ? me!.allowance.usdcRouter : me!.allowance.nvdaxRouter;
    if (allowance < amountIn) {
      if (!(await write(`Approve ${buy ? "USDC" : "NVDAx"}`, tokenIn, erc20Abi, "approve", [router, maxUint256]))) return;
    }
    const ok = await write("Swap", router, poolSwapTestAbi, "swap", [
      dep.poolKey,
      {
        zeroForOne,
        amountSpecified: -amountIn, // exact input
        sqrtPriceLimitX96: priceLimit(me!.pool.sqrtPriceX96, zeroForOne, SLIPPAGE_BPS),
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ]);
    if (ok) amount.setText("");
  }

  return (
    <Card
      title="Swap · Uniswap v4"
      hint="The pool the vault unwinds into. A bot keeps it on HyperCore's price, as arbitrageurs would on mainnet."
    >
      <div className="flex gap-2">
        <Action tone={buy ? "primary" : "plain"} label="Buy NVDAx" onClick={() => setBuy(true)} />
        <Action tone={buy ? "plain" : "primary"} label="Sell NVDAx" onClick={() => setBuy(false)} />
      </div>
      <AmountInput amount={amount} unit={buy ? "USDC" : "NVDAx"} max={{ value: buy ? me.usdc : me.nvdax }} />
      <Rows
        rows={[
          ["Pool price", price === 0 ? "not seeded" : `$${price.toFixed(2)}`],
          ["You get about", `${estimate.toLocaleString("en-US", { maximumFractionDigits: buy ? 5 : 2 })} ${buy ? "NVDAx" : "USDC"}`],
          ["Your balance", buy ? `${fmt(me.usdc, 6, 2)} USDC` : `${fmt(me.nvdax, 18)} NVDAx`],
        ]}
      />
      <p className="text-xs opacity-60">Stops at {SLIPPAGE_BPS / 100}% price impact; a bigger swap fills only part.</p>
      <Action label="Swap" onClick={swap} disabled={!amount.value || price === 0} />
    </Card>
  );
}
