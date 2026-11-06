"use client";

import { erc20Abi, maxUint256 } from "viem";
import { iMorphoAbi } from "@afterbell/shared/abis";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, AmountInput, Card, Note, Rows, fmt, useAmount } from "./ui";

const TITLE = "Lend · Morpho Market C";

/**
 * Supply USDC to market C, the market borrowers draw on and the vault liquidates. Lenders are who Afterbell protects:
 * when a borrower goes under, the vault repays their debt in full and takes the stock, so no bad debt reaches them.
 */
export function LendCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const amount = useAmount(6);
  if (!address || !me) return <Card title={TITLE} hint="Connect a wallet first." />;

  const params = me.market.params;
  const l = me.lend;
  const utilization = l.marketSupply === 0n ? 0 : Number(l.marketBorrow) / Number(l.marketSupply);
  // what can come out right now: this wallet's supply, up to the market's unborrowed USDC
  const free = l.marketSupply > l.marketBorrow ? l.marketSupply - l.marketBorrow : 0n;
  const withdrawable = l.value < free ? l.value : free;

  async function supply() {
    const value = amount.value;
    if (value === null || value === 0n) return;
    if (me!.allowance.usdcMorpho < value) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    if (await write("Lend USDC", dep.morpho, iMorphoAbi, "supply", [params, value, 0n, address, "0x"])) {
      amount.setText("");
    }
  }

  async function withdraw() {
    // all of it by shares when the market can pay it out; otherwise as much USDC as is free
    const all = withdrawable === l.value;
    await write(
      "Withdraw lending",
      dep.morpho,
      iMorphoAbi,
      "withdraw",
      all ? [params, 0n, l.shares, address, address] : [params, withdrawable, 0n, address, address],
    );
  }

  return (
    <Card title={TITLE} meta={<span>utilization {(utilization * 100).toFixed(1)}%</span>}>
      <Rows
        rows={[
          ["Your supply", l.shares > 0n ? `${fmt(l.value, 6, 4)} USDC` : "–"],
          ["Market supplied / borrowed", `${fmt(l.marketSupply, 6, 2)} / ${fmt(l.marketBorrow, 6, 2)} USDC`],
          ["Wallet", `${fmt(me.usdc, 6, 2)} USDC`],
        ]}
      />
      <AmountInput amount={amount} unit="USDC" max={{ value: me.usdc, label: "Max" }} />
      <Action label="Lend USDC" onClick={supply} disabled={!amount.value} className="w-full" />
      {l.shares > 0n && (
        <Action
          label={withdrawable === l.value ? "Withdraw all" : `Withdraw ${fmt(withdrawable, 6, 2)} USDC (rest is lent out)`}
          onClick={withdraw}
          disabled={withdrawable === 0n}
          className="w-full"
        />
      )}
      <Note>
        Interest accrues every second (Morpho&apos;s AdaptiveCurve rate model). If a borrower goes under, the Afterbell
        vault liquidates them right away and repays the loan in full, so lenders never sit on bad debt.
      </Note>
    </Card>
  );
}
