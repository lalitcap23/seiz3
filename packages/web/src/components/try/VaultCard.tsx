"use client";

import { erc20Abi, maxUint256 } from "viem";
import { seiz3VaultAbi } from "@seiz3/shared/abis";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, AmountInput, Card, Note, Rows, Section, fmt, useAmount } from "./ui";

const TITLE = "Vault · provide liquidity";

/** LP side: USDC in, abUSDC shares out. Withdrawals are instant while idle USDC covers them, queued otherwise. */
export function VaultCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const deposit = useAmount(6);
  if (!address || !me) return <Card title={TITLE} hint="Connect a wallet first." />;
  const v = me.vault;
  const instant = v.shares > 0n && v.maxRedeem >= v.shares;

  async function doDeposit() {
    const amount = deposit.value;
    if (amount === null || amount === 0n) return;
    if (me!.allowance.usdcVault < amount) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.vault, maxUint256]))) return;
    }
    if (await write("Deposit", dep.vault, seiz3VaultAbi, "deposit", [amount, address])) deposit.setText("");
  }

  return (
    <Card
      title={TITLE}
      meta={<span>px {v.sharePrice.toFixed(4)}</span>}
      hint="Your USDC pays for liquidated collateral; the vault earns Morpho's discount and hedges the stock on HyperCore."
    >
      <Rows
        rows={[
          ["Share price", `${v.sharePrice.toFixed(4)} USDC`],
          ["Your position", `${fmt(v.value, 6, 2)} USDC`],
          ["Queued withdrawal", v.queued > 0n ? `${fmt(v.queuedValue, 6, 2)} USDC` : "–"],
          ["Vault cash for withdrawals", `${fmt(v.instantLiquidity, 6, 2)} USDC`],
        ]}
      />
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <Section title="Deposit USDC" aside={`wallet ${fmt(me.usdc, 6, 2)}`} />
        <AmountInput amount={deposit} unit="USDC" max={{ value: me.usdc }} />
        <Action label="Deposit" onClick={doDeposit} disabled={!deposit.value} className="w-full" />
      </div>
      {(v.shares > 0n || v.queued > 0n) && (
        <div className="flex flex-wrap gap-2">
          {v.shares > 0n && (
            <Action
              tone="plain"
              label={instant ? "Withdraw all" : "Withdraw all (queued)"}
              onClick={() => write("Withdraw", dep.vault, seiz3VaultAbi, "requestWithdraw", [v.shares])}
              className="flex-1"
            />
          )}
          {v.queued > 0n && (
            <Action
              tone="plain"
              label="Claim queued"
              onClick={() => write("Claim", dep.vault, seiz3VaultAbi, "claimQueued", [])}
              className="flex-1"
            />
          )}
        </div>
      )}
      {!instant && v.shares > 0n && (
        <Note>While the vault holds stock its cash is low; a queued withdrawal is paid at the share price of the day you claim.</Note>
      )}
    </Card>
  );
}
