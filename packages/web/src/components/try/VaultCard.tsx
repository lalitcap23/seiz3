"use client";

import { erc20Abi, maxUint256 } from "viem";
import { afterbellVaultAbi } from "@afterbell/shared/abis";
import { dep } from "@/lib/chain";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Action, AmountInput, Card, Rows, fmt, useAmount } from "./ui";

/** LP side: USDC in, abUSDC shares out. Withdrawals are instant while idle USDC covers them, queued otherwise. */
export function VaultCard({ me }: { me: Me | undefined }) {
  const { address, write } = useWallet();
  const deposit = useAmount(6);
  if (!address || !me) return <Card title="Provide liquidity · Afterbell vault" hint="Connect a wallet first." />;
  const v = me.vault;
  const instant = v.shares > 0n && v.maxRedeem >= v.shares;

  async function doDeposit() {
    const amount = deposit.value;
    if (amount === null || amount === 0n) return;
    if (me!.allowance.usdcVault < amount) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.vault, maxUint256]))) return;
    }
    if (await write("Deposit", dep.vault, afterbellVaultAbi, "deposit", [amount, address])) deposit.setText("");
  }

  return (
    <Card
      title="Provide liquidity · Afterbell vault"
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
      <AmountInput amount={deposit} unit="USDC" max={{ value: me.usdc }} />
      <div className="flex flex-wrap gap-2">
        <Action label="Deposit" onClick={doDeposit} disabled={!deposit.value} />
        {v.shares > 0n && (
          <Action
            tone="plain"
            label={instant ? "Withdraw all" : "Withdraw all (queued)"}
            onClick={() => write("Withdraw", dep.vault, afterbellVaultAbi, "requestWithdraw", [v.shares])}
          />
        )}
        {v.queued > 0n && (
          <Action tone="plain" label="Claim queued" onClick={() => write("Claim", dep.vault, afterbellVaultAbi, "claimQueued", [])} />
        )}
      </div>
      {!instant && v.shares > 0n && (
        <p className="text-xs opacity-60">
          While the vault holds stock its cash is low; a queued withdrawal is paid at the share price of the day you claim.
        </p>
      )}
    </Card>
  );
}
