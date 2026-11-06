"use client";

import { erc20Abi, maxUint256 } from "viem";
import { iMorphoAbi } from "@afterbell/shared/abis";
import { useSnapshot } from "@/lib/api";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { LoanTimeline } from "./LoanTimeline";
import { Action, AmountInput, Card, Rows, fmt, useAmount } from "./ui";

const WAD = 10n ** 18n;
/** Max leaves this much interest (in seconds of it) under the limit: enough for the tx to land, then it tips over. */
const TIP_OVER_SEC = 15n;

/** USDC Max may borrow: up to the LLTV, minus the rounding Morpho adds and ~15 s of interest. */
function maxBorrow(me: Me): bigint {
  const room = me.position.maxDebt - me.position.debt;
  const interest = (me.position.maxDebt * me.market.ratePerSec * TIP_OVER_SEC) / WAD;
  const margin = (interest > 3n ? interest : 3n) + 1n;
  const out = room - margin;
  if (out <= 0n) return 0n;
  return out < me.market.liquidity ? out : me.market.liquidity;
}

export function BorrowCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const collateral = useAmount(18);
  const borrow = useAmount(6);
  const { data: snapshot } = useSnapshot();
  if (!address || !me) return <Card title="Borrow on Morpho · Market C" hint="Connect a wallet first." />;

  const p = me.position;
  const params = me.market.params;
  const priceUsd = Number(me.market.price / 10n ** 18n) / 1e6;

  async function supplyCollateral() {
    const amount = collateral.value;
    if (amount === null || amount === 0n) return;
    if (me!.allowance.nvdaxMorpho < amount) {
      if (!(await write("Approve NVDAx", dep.nvdax, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    if (await write("Deposit collateral", dep.morpho, iMorphoAbi, "supplyCollateral", [params, amount, address, "0x"])) {
      collateral.setText("");
    }
  }

  async function doBorrow() {
    const amount = borrow.value;
    if (amount === null || amount === 0n) return;
    if (await write("Borrow USDC", dep.morpho, iMorphoAbi, "borrow", [params, amount, 0n, address, address])) {
      borrow.setText("");
    }
  }

  async function repayAll() {
    if (me!.allowance.usdcMorpho < p.debt) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    await write("Repay", dep.morpho, iMorphoAbi, "repay", [params, 0n, p.borrowShares, address, "0x"]);
  }

  return (
    <Card
      title="Borrow on Morpho · Market C"
      hint="The Afterbell market: when a loan here goes under, the vault buys the collateral and shorts it on HyperCore."
    >
      <Rows
        rows={[
          ["NVDA price (market oracle)", `$${priceUsd.toFixed(2)}`],
          ["Your collateral", `${fmt(p.collateral, 18)} NVDAx`],
          ["Your debt", `${fmt(p.debt, 6, 6)} USDC`],
          [
            "LTV / LLTV",
            <span key="ltv" className={p.debt > p.maxDebt ? "text-red-500" : ""}>
              {(p.ltv * 100).toFixed(2)}% / {(Number(params.lltv) / 1e16).toFixed(0)}%
            </span>,
          ],
          ["Liquidated below", p.debt === 0n ? "–" : `$${(Number(p.liquidationPriceUsd6) / 1e6).toFixed(2)}`],
          ["USDC left to borrow in market", fmt(me.market.liquidity, 6, 2)],
        ]}
      />

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium opacity-70">1 · Deposit NVDAx as collateral</span>
        <AmountInput amount={collateral} unit="NVDAx" max={{ value: me.nvdax }} />
        <Action label="Deposit collateral" onClick={supplyCollateral} disabled={!collateral.value} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium opacity-70">2 · Borrow USDC</span>
        <AmountInput amount={borrow} unit="USDC" max={{ value: maxBorrow(me), label: "Max" }} />
        <p className="text-xs opacity-60">
          Max borrows right up to the {(Number(params.lltv) / 1e16).toFixed(0)}% limit. Interest crosses it within about a
          minute, and the keeper liquidates you through the Afterbell vault: it buys your NVDAx at Morpho&apos;s discount and
          shorts the same amount on HyperCore. You keep the USDC; the collateral goes.
        </p>
        <Action label="Borrow" onClick={doBorrow} disabled={!borrow.value || p.collateral === 0n} />
      </div>

      <div className="flex flex-wrap gap-2">
        {p.borrowShares > 0n && <Action tone="plain" label="Repay all" onClick={repayAll} />}
        {p.borrowShares === 0n && p.collateral > 0n && (
          <Action
            tone="plain"
            label="Withdraw collateral"
            onClick={() => write("Withdraw collateral", dep.morpho, iMorphoAbi, "withdrawCollateral", [params, p.collateral, address, address])}
          />
        )}
      </div>

      {p.collateral > 0n && p.debt < 10_000n && p.debt > 0n && (
        <p className="text-xs opacity-70">
          After a liquidation Morpho takes only the collateral the debt needs and leaves you the rest, plus a dust amount of
          debt. Repay all (a few hundredths of a cent) to withdraw the {fmt(p.collateral, 18)} NVDAx you kept.
        </p>
      )}

      {snapshot && (
        <LoanTimeline operations={snapshot.operations ?? []} address={address} szDecimals={dep.hypercore.szDecimals} />
      )}
    </Card>
  );
}
