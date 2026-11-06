"use client";

import { useState } from "react";
import { erc20Abi, maxUint256 } from "viem";
import { poolSwapTestAbi } from "@afterbell/shared/abis";
import { priceLimit } from "@afterbell/shared/pool";
import { dep } from "@/lib/chain";
import { useHookQuote } from "@/lib/hook";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, AmountInput, Card, Rows, fmt, useAmount } from "./ui";

const SLIPPAGE_BPS = 100;
const FEE = 0.003; // pools without the hook
const CORE_UNIT = 1e-3; // the hook sells whole Core size units (szDecimals 3)
const TITLE = "Swap · Uniswap v4";

/**
 * USDC ↔ NVDAx on the vault's Uniswap v4 pool, through v4-core's PoolSwapTest router. With AfterbellHook on the pool,
 * a buy is filled first from the vault's hedged stock at its ask, and the rest goes to the curve at the hook's fee.
 */
export function SwapCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const [buy, setBuy] = useState(true); // buy NVDAx with USDC
  const amount = useAmount(buy ? 6 : 18);
  const quote = useHookQuote().data ?? null;
  if (!dep.swapRouter) return <Card title={TITLE} hint="No swap router on this network yet." />;
  if (!address || !me) return <Card title={TITLE} hint="Connect a wallet first." />;

  const router = dep.swapRouter;
  const tokenIn = buy ? dep.usdc : dep.nvdax;
  const zeroForOne = dep.poolKey.currency0.toLowerCase() === tokenIn.toLowerCase();
  const price = Number(me.pool.priceUsd6) / 1e6;
  const inHuman = amount.value === null ? 0 : Number(amount.value) / 10 ** (buy ? 6 : 18);
  const fee = quote ? quote.fee / 1e6 : FEE;
  const ask = quote ? Number(quote.askUsd6) / 1e6 : 0;
  const capacity = quote ? Number(quote.capacity) / 1e18 : 0;
  // the hook fills what it can at the ask, on the Core size grid; the rest goes to the curve
  const fromVault = buy && capacity > 0 && ask > 0 ? Math.floor(Math.min(inHuman / ask, capacity) / CORE_UNIT) * CORE_UNIT : 0;
  const toCurve = buy ? inHuman - fromVault * ask : inHuman;
  const estimate = fromVault + (price === 0 ? 0 : (buy ? toCurve / price : toCurve * price) * (1 - fee));

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
      title={TITLE}
      meta={<span>NVDAx / USDC</span>}
      hint={
        dep.hook
          ? "The pool the vault unwinds into. Its hook sells you the vault's hedged stock at the ask whenever the pool trades at or above it."
          : "The pool the vault unwinds into. A bot keeps it on HyperCore's price, as arbitrageurs would on mainnet."
      }
    >
      <div className="grid grid-cols-2 gap-1 rounded-[3px] bg-well p-1">
        {[true, false].map((side) => (
          <button
            key={String(side)}
            type="button"
            onClick={() => setBuy(side)}
            className={`h-8 rounded-[2px] text-[13px] font-semibold ${
              buy === side ? (side ? "bg-up/15 text-up" : "bg-down/15 text-down") : "text-muted hover:text-foreground"
            }`}
          >
            {side ? "Buy NVDAx" : "Sell NVDAx"}
          </button>
        ))}
      </div>
      <AmountInput amount={amount} unit={buy ? "USDC" : "NVDAx"} max={{ value: buy ? me.usdc : me.nvdax }} />
      <Rows
        rows={[
          ["Pool price", price === 0 ? "not seeded" : `$${price.toFixed(2)}`],
          ...(buy && quote
            ? ([
                [
                  "Vault's ask (v4 hook)",
                  capacity > 0 ? `$${ask.toFixed(2)}, up to ${capacity.toFixed(3)} NVDAx` : `$${ask.toFixed(2)}, waiting`,
                ],
                ["From the vault", `${fromVault.toFixed(3)} NVDAx`],
              ] as [string, string][])
            : []),
          ["Curve fee", `${(fee * 100).toFixed(2)}%${quote && !quote.open ? " (after hours)" : ""}`],
          ["You get about", `${estimate.toLocaleString("en-US", { maximumFractionDigits: buy ? 5 : 2 })} ${buy ? "NVDAx" : "USDC"}`],
          ["Your balance", buy ? `${fmt(me.usdc, 6, 2)} USDC` : `${fmt(me.nvdax, 18)} NVDAx`],
          ["Stops at price impact", `${SLIPPAGE_BPS / 100}% (partial fill)`],
        ]}
      />
      <Action
        tone={buy ? "up" : "down"}
        label={buy ? "Buy NVDAx" : "Sell NVDAx"}
        onClick={swap}
        disabled={!amount.value || price === 0}
        className="w-full"
      />
    </Card>
  );
}
