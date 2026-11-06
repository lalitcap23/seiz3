"use client";

import { erc20Abi, maxUint256 } from "viem";
import { iMorphoAbi } from "@afterbell/shared/abis";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Label, Stat, Tag } from "../ui";
import { Action, AmountInput, Card, Note, Rows, Section, fmt, useAmount } from "./ui";

const WAD = 10n ** 18n;
/** Max leaves this much interest (in seconds of it) under the limit: enough for the tx to land, then it tips over. */
const TIP_OVER_SEC = 15n;

/** What Max leaves under the limit: ~15 s of interest, at least the rounding Morpho adds. */
function margin(me: Me): bigint {
  const interest = (me.position.maxDebt * me.market.ratePerSec * TIP_OVER_SEC) / WAD;
  return (interest > 3n ? interest : 3n) + 1n;
}

/** USDC Max may borrow: up to the LLTV, minus the margin. */
function maxBorrow(me: Me): bigint {
  const out = me.position.maxDebt - me.position.debt - margin(me);
  if (out <= 0n) return 0n;
  return out < me.market.liquidity ? out : me.market.liquidity;
}

/** Seconds of interest until a Max borrow crosses the limit: the margin over the interest a second. */
function tipOverSec(me: Me): number | null {
  const perSec = (Number(me.position.maxDebt) * Number(me.market.ratePerSec)) / 1e18;
  return perSec > 0 ? Math.ceil(Number(margin(me)) / perSec) : null;
}

/** Seconds until the open loan's interest crosses the limit at today's price (null: no loan, or no interest). */
function secondsLeft(me: Me): number | null {
  const p = me.position;
  if (p.debt === 0n || p.debt > p.maxDebt) return null;
  const perSec = (Number(p.debt) * Number(me.market.ratePerSec)) / 1e18;
  return perSec > 0 ? Math.floor(Number(p.maxDebt - p.debt) / perSec) : null;
}

/** Debt Morpho leaves behind after a liquidation: a few wei of rounding (under a cent). */
const DUST = 10_000n;

const TITLE = "Borrow · Morpho Market C";

export function BorrowCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const collateral = useAmount(18);
  const borrow = useAmount(6);
  if (!address || !me) return <Card title={TITLE} hint="Connect a wallet first." />;

  const p = me.position;
  const params = me.market.params;
  const priceUsd = Number(me.market.price / 10n ** 18n) / 1e6;
  const lltv = Number(params.lltv) / 1e18;
  const fill = lltv === 0 ? 0 : p.ltv / lltv;
  const over = p.debt > p.maxDebt;
  const tone = over ? "text-down" : fill > 0.95 ? "text-warn" : p.debt === 0n ? "text-muted" : "text-up";
  const bar = over ? "bg-down" : fill > 0.95 ? "bg-warn" : "bg-up";
  const left = secondsLeft(me);

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
      title={
        <>
          {TITLE} <Tag tone="brand">afterbell</Tag>
        </>
      }
      meta={<span>LLTV {(lltv * 100).toFixed(0)}%</span>}
    >
      {/* the loan at a glance: how close it is to the line, and the price that takes it over */}
      <div className="flex flex-col gap-2 rounded-[3px] border border-line bg-well p-3">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label>LTV / LLTV</Label>
            <p className={`font-mono text-[26px] leading-none font-semibold ${tone}`}>
              {(p.ltv * 100).toFixed(2)}%
              <span className="text-[14px] font-normal text-faint"> / {(lltv * 100).toFixed(0)}%</span>
            </p>
          </div>
          <Stat
            label="Liquidated below"
            value={p.debt === 0n ? "–" : `$${(Number(p.liquidationPriceUsd6) / 1e6).toFixed(2)}`}
            className="items-end"
          />
        </div>
        <div className="h-1.5 rounded-full bg-line-strong">
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(1, fill) * 100}%` }} />
        </div>
        {over && (
          <p className="font-mono text-[11px] text-down">Over the limit: the keeper liquidates it within seconds.</p>
        )}
        {!over && left !== null && left < 3600 && (
          <p className={`font-mono text-[11px] ${left < 60 ? "text-warn" : "text-faint"}`}>
            Interest crosses the limit in ~{left} s at this price; then the keeper liquidates it.
          </p>
        )}
      </div>
      <Rows
        rows={[
          ["NVDA price (market oracle)", `$${priceUsd.toFixed(2)}`],
          ["Your collateral", `${fmt(p.collateral, 18)} NVDAx`],
          ["Your debt", `${fmt(p.debt, 6, 6)} USDC`],
          ["USDC left to borrow in market", fmt(me.market.liquidity, 6, 2)],
        ]}
      />

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <Section step="01" title="Deposit NVDAx collateral" aside={`wallet ${fmt(me.nvdax, 18)}`} />
        <AmountInput amount={collateral} unit="NVDAx" max={{ value: me.nvdax }} />
        <Action label="Deposit collateral" onClick={supplyCollateral} disabled={!collateral.value} className="w-full" />
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <Section step="02" title="Borrow USDC" aside={`max ${fmt(maxBorrow(me), 6, 2)}`} />
        <AmountInput amount={borrow} unit="USDC" max={{ value: maxBorrow(me), label: "Max" }} />
        <Note>
          Max borrows right up to the {(lltv * 100).toFixed(0)}% limit. Interest crosses it{" "}
          {tipOverSec(me) === null ? "soon after" : `about ${tipOverSec(me)} s after the borrow lands`}, and the
          keeper liquidates you through the Afterbell vault: it buys your NVDAx at Morpho&apos;s discount and shorts the same
          amount on HyperCore. You keep the USDC; the collateral goes.
        </Note>
        <Action label="Borrow" onClick={doBorrow} disabled={!borrow.value || p.collateral === 0n} className="w-full" />
      </div>

      {(p.borrowShares > 0n || p.collateral > 0n) && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {p.borrowShares > 0n && <Action tone="plain" label="Repay all" onClick={repayAll} className="flex-1" />}
          {p.borrowShares === 0n && p.collateral > 0n && (
            <Action
              tone="plain"
              label="Withdraw collateral"
              onClick={() => write("Withdraw collateral", dep.morpho, iMorphoAbi, "withdrawCollateral", [params, p.collateral, address, address])}
              className="flex-1"
            />
          )}
        </div>
      )}

      {p.collateral > 0n && p.debt < DUST && p.debt > 0n && (
        <Note>
          After a liquidation Morpho takes only the collateral the debt needs and leaves you the rest, plus a dust amount of
          debt. Repay all (a few hundredths of a cent) to withdraw the {fmt(p.collateral, 18)} NVDAx you kept.
        </Note>
      )}
    </Card>
  );
}
