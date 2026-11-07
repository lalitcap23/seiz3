"use client";

import { useEffect, useState, type ReactNode } from "react";
import { erc20Abi, maxUint256 } from "viem";
import type { Operation } from "@seiz3/shared";
import { iMorphoAbi } from "@seiz3/shared/abis";
import { CHAIN_LABEL, dep, GAS } from "@/lib/chain";
import { nvdax, shortHash, usd } from "@/lib/format";
import type { Me } from "@/lib/me";
import { useWallet } from "@/lib/wallet";
import { Label, Meter, Panel, TxLink } from "../ui";
import { DUST, maxBorrow, secondsLeft, STEPS, tipOverSec, type Journey, type Role, type StepKey } from "./journey";
import { Action, AmountInput, fmt, useAmount } from "./ui";
import { FaucetStatus, useFaucet } from "./WalletPanel";

/** Moves the card to another step, or (no argument) back to the one the wallet is at. */
type Go = (step?: StepKey) => void;

/**
 * The borrower's steps as tabs: done, the next one, still to come. Any of them opens in the card below; `current` is
 * where the wallet actually is, `selected` the one on show.
 */
export function Progress({ current, selected, onSelect }: { current: StepKey; selected: StepKey; onSelect: Go }) {
  // while the wallet is read, only "connect" is known to be done
  const done = current === "done" ? STEPS.length : current === "loading" ? 1 : STEPS.findIndex((s) => s.key === current);
  return (
    <div
      role="tablist"
      aria-label="Steps"
      className="grid grid-cols-3 gap-px overflow-hidden rounded-[3px] border border-line bg-line sm:grid-cols-6"
    >
      {STEPS.map((s, i) => {
        const next = s.key === current;
        const open = s.key === selected;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={open}
            onClick={() => onSelect(s.key)}
            className={`flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
              open ? "bg-raised shadow-[inset_0_2px_0_var(--color-brand)]" : "bg-panel hover:bg-raised/60"
            }`}
          >
            <span
              className={`grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold ${
                i < done ? "bg-up/15 text-up" : next ? "bg-brand text-black" : "bg-foreground/6 text-faint"
              }`}
            >
              {i < done ? "✓" : i + 1}
            </span>
            <span
              className={`truncate text-[12px] ${open ? "font-medium text-foreground" : i < done || next ? "text-muted" : "text-faint"}`}
            >
              {s.label}
            </span>
            {next && !open && (
              <span className="ml-auto hidden font-mono text-[9px] tracking-[0.08em] text-brand uppercase md:inline">next</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** One step's content: what to do, why, the action, and what comes after it. */
function Body({ title, why, then, children }: { title: ReactNode; why: ReactNode; then?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[19px] font-semibold tracking-tight">{title}</h3>
        <p className="max-w-[62ch] text-[13px] leading-relaxed text-muted">{why}</p>
      </div>
      {children && <div className="flex max-w-[480px] flex-col gap-2.5">{children}</div>}
      {then && (
        <p className="flex items-baseline gap-2 border-t border-line pt-3 text-[12px] text-faint">
          <Label className="text-faint">Then</Label>
          <span>{then}</span>
        </p>
      )}
    </>
  );
}

/** A small text button for the way out of a step, kept apart from its main action. */
function Aside({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="self-start font-mono text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:text-faint"
    >
      {label}
    </button>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <p className="rounded-[3px] border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">{children}</p>;
}

const priceUsd = (me: Me) => Number(me.market.price / 10n ** 18n) / 1e6;
const lltvPct = (me: Me) => ((Number(me.market.params.lltv) / 1e18) * 100).toFixed(0);

/** What each step is, for a look before the wallet is connected. */
const PREVIEW: Record<"faucet" | "deposit" | "borrow" | "liquidate" | "unwind", { title: string; why: string }> = {
  faucet: {
    title: "Get test tokens",
    why: "One drip gives you NVDAx (tokenized NVIDIA stock) to borrow against, some USDC, and gas.",
  },
  deposit: {
    title: "Deposit NVDAx as collateral",
    why: "Your NVDAx backs a USDC loan on Morpho Market C, the lending market Seiz3 protects.",
  },
  borrow: {
    title: "Borrow USDC to the limit",
    why: "Max borrows right up to the limit. Seconds later interest pushes the loan over it, and Seiz3's keeper liquidates you. You keep the USDC.",
  },
  liquidate: {
    title: "Get liquidated",
    why: "The vault repays your debt to Morpho, takes your NVDAx at Morpho's discount, and shorts the same amount on HyperCore.",
  },
  unwind: {
    title: "Watch the vault sell your stock",
    why: "Buyers get first pick through the Uniswap v4 hook; the keeper sells the rest into the pool and closes the short.",
  },
};

/** The way into the wallet: install, connect, or switch network. */
function ConnectAction() {
  const { hasWallet, address, connect, switchChain } = useWallet();
  if (!hasWallet) return <Warn>Install MetaMask or Rabby, then reload this page.</Warn>;
  if (address === null) return <Action label="Connect wallet" onClick={connect} />;
  return <Action label={`Switch to ${CHAIN_LABEL}`} onClick={switchChain} />;
}

function ConnectStep({ go }: { go: Go }) {
  const { hasWallet, address, onChain } = useWallet();
  const then = "Get free test tokens from the faucet.";
  if (address !== null && onChain) {
    return (
      <Body
        title={<span className="text-up">Wallet connected ✓</span>}
        why={`You're connected as ${shortHash(address)} on ${CHAIN_LABEL}. To use another account, switch it in your wallet and this page follows.`}
      >
        <Action label="Go to your next step" onClick={() => go()} />
      </Body>
    );
  }
  const title = !hasWallet ? "Install a wallet" : address === null ? "Connect your wallet" : `Switch to ${CHAIN_LABEL}`;
  const why = !hasWallet
    ? `Seiz3 runs on ${CHAIN_LABEL} with test tokens only.`
    : address === null
      ? `Everything here runs on ${CHAIN_LABEL} with free test tokens. No real money.`
      : "Your wallet is on another network.";
  return (
    <Body title={title} why={why} then={then}>
      <ConnectAction />
    </Body>
  );
}

function FaucetStep({ me, onRole }: { me: Me; onRole: (r: Role) => void }) {
  const faucet = useFaucet(me);
  const why =
    me.nvdax > 0n && me.hype === 0n
      ? `You have NVDAx but no ${GAS} to pay gas with. The faucet sends some, with more NVDAx and USDC.`
      : `One drip gives you NVDAx (tokenized NVIDIA stock) to borrow against, some USDC, and ${GAS} for gas.`;
  return (
    <Body title="Get test tokens" why={why} then="Deposit the NVDAx as collateral on Morpho.">
      {faucet.deployed ? (
        <>
          <Action
            label={faucet.waitUntil ? `Next drip ${new Date(faucet.waitUntil * 1000).toLocaleString()}` : "Get test tokens"}
            onClick={faucet.drip}
            disabled={faucet.disabled}
          />
          <FaucetStatus status={faucet.status} />
        </>
      ) : (
        <Warn>No faucet on this network yet.</Warn>
      )}
      {faucet.waitUntil > 0 && me.usdc > 0n && me.hype > 0n && (
        <Aside label="Or buy NVDAx with your USDC as a Buyer →" onClick={() => onRole("buyer")} />
      )}
    </Body>
  );
}

function DepositStep({ me, go }: { me: Me; go: Go }) {
  const { address, write } = useWallet();
  const amount = useAmount(18);
  // empty field: all of it
  const value = amount.text.trim() === "" ? me.nvdax : amount.value;
  const ok = value !== null && value > 0n && value <= me.nvdax;
  const title = "Deposit NVDAx as collateral";
  const then = "Borrow USDC against it.";

  if (me.nvdax === 0n) {
    return (
      <Body
        title={title}
        why={
          me.position.collateral > 0n
            ? `You have no NVDAx in your wallet; ${fmt(me.position.collateral, 18)} NVDAx is already deposited. Get more from the faucet to add to it.`
            : "You have no NVDAx in your wallet yet. The faucet sends some."
        }
        then={then}
      >
        <Action label="Get test tokens first" onClick={() => go("faucet")} />
      </Body>
    );
  }

  async function deposit() {
    if (!ok) return;
    if (me.allowance.nvdaxMorpho < value) {
      if (!(await write("Approve NVDAx", dep.nvdax, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    if (await write("Deposit collateral", dep.morpho, iMorphoAbi, "supplyCollateral", [me.market.params, value, address, "0x"])) {
      amount.setText("");
      go();
    }
  }

  return (
    <Body
      title={title}
      why={
        me.position.debt >= DUST
          ? "Adding collateral to your open loan moves it further from the limit, so it's liquidated later."
          : "Your NVDAx backs a USDC loan on Morpho Market C, the lending market Seiz3 protects. You can take it back any time you have no loan."
      }
      then={then}
    >
      <div className="flex items-baseline justify-between font-mono text-[11px] text-faint">
        <span>Amount (empty = all)</span>
        <span>
          wallet {fmt(me.nvdax, 18)} NVDAx · ~${((Number(me.nvdax) / 1e18) * priceUsd(me)).toFixed(2)}
        </span>
      </div>
      <AmountInput amount={amount} unit="NVDAx" max={{ value: me.nvdax }} />
      <Action
        label={amount.text.trim() === "" ? `Deposit all ${fmt(me.nvdax, 18)} NVDAx` : `Deposit ${amount.text.trim()} NVDAx`}
        onClick={deposit}
        disabled={!ok}
      />
    </Body>
  );
}

function BorrowStep({ me, go, onRole }: { me: Me; go: Go; onRole: (r: Role) => void }) {
  const { address, write } = useWallet();
  const amount = useAmount(6);
  const p = me.position;
  const max = maxBorrow(me);
  const value = amount.text.trim() === "" ? max : amount.value;
  const tip = tipOverSec(me);
  const open = p.debt >= DUST;
  // after a liquidation Morpho keeps only the collateral the debt needs, and leaves a few wei of debt
  const leftover = p.borrowShares > 0n && !open;
  const title = open ? "Borrow more USDC" : "Borrow USDC to the limit";
  const then = "Wait a few seconds for the liquidation.";

  if (p.collateral === 0n) {
    return (
      <Body title={title} why="You have no collateral on Morpho yet, so there's nothing to borrow against." then={then}>
        <Action label="Deposit NVDAx first" onClick={() => go("deposit")} />
      </Body>
    );
  }

  async function borrow() {
    if (value === null || value === 0n) return;
    if (await write("Borrow USDC", dep.morpho, iMorphoAbi, "borrow", [me.market.params, value, 0n, address, address])) {
      amount.setText("");
      go();
    }
  }

  async function repayDust() {
    if (me.allowance.usdcMorpho < p.debt + 1n) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    await write("Repay", dep.morpho, iMorphoAbi, "repay", [me.market.params, 0n, p.borrowShares, address, "0x"]);
  }

  return (
    <Body
      title={title}
      why={
        open ? (
          <>
            You already owe {fmt(p.debt, 6, 2)} USDC. Max takes the loan right up to the {lltvPct(me)}% limit, and interest
            pushes it over {tip === null ? "soon after" : `about ${tip} s later`}.
          </>
        ) : (
          <>
            Max borrows right up to the {lltvPct(me)}% limit. {tip === null ? "Soon after" : `About ${tip} s later`}, interest
            pushes the loan over it and Seiz3&apos;s keeper liquidates you. That liquidation is what you&apos;re here to see.
            You keep the USDC.
          </>
        )
      }
      then={then}
    >
      <div className="flex items-baseline justify-between font-mono text-[11px] text-faint">
        <span>
          collateral {fmt(p.collateral, 18)} NVDAx @ ${priceUsd(me).toFixed(2)}
        </span>
        <span>max {fmt(max, 6, 2)} USDC</span>
      </div>
      <AmountInput amount={amount} unit="USDC" max={{ value: max }} />
      <Action
        label={amount.text.trim() === "" ? `Borrow max ${fmt(max, 6, 2)} USDC` : `Borrow ${amount.text.trim()} USDC`}
        onClick={borrow}
        disabled={value === null || value === 0n}
      />
      {max === 0n && me.market.liquidity <= 0n && (
        <Warn>
          Market C has no USDC to lend right now.{" "}
          <button type="button" className="underline" onClick={() => onRole("lender")}>
            Lend some as a Lender
          </button>
          , or try again in a minute.
        </Warn>
      )}
      {leftover && (
        <>
          <p className="text-[12px] text-muted">
            Morpho left you this collateral after your last liquidation, plus {fmt(p.debt, 6, 6)} USDC of rounding debt.
            Borrow against it again, or repay that dust to withdraw it.
          </p>
          <Aside label="Repay the dust" onClick={() => void repayDust()} />
        </>
      )}
      {p.borrowShares === 0n && (
        <Aside
          label="Withdraw collateral instead"
          onClick={() =>
            void write("Withdraw collateral", dep.morpho, iMorphoAbi, "withdrawCollateral", [
              me.market.params,
              p.collateral,
              address,
              address,
            ])
          }
        />
      )}
    </Body>
  );
}

/** The loan against its limit: the LTV, the bar, and the debt. */
function LoanMeter({ me, over }: { me: Me; over: boolean }) {
  const p = me.position;
  const lltv = Number(me.market.params.lltv) / 1e18;
  const fill = lltv === 0 ? 0 : p.ltv / lltv;
  const tone = over ? "text-down" : fill > 0.95 ? "text-warn" : "text-up";
  const bar = over ? "bg-down" : fill > 0.95 ? "bg-warn" : "bg-up";
  return (
    <div className="flex flex-col gap-2 rounded-[3px] border border-line bg-well p-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label>Loan-to-value / limit</Label>
          <p className={`font-mono text-[24px] leading-none font-semibold ${tone}`}>
            {(p.ltv * 100).toFixed(2)}%<span className="text-[14px] font-normal text-faint"> / {(lltv * 100).toFixed(0)}%</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 font-mono text-[12px]">
          <Label>Debt</Label>
          <span>{fmt(p.debt, 6, 4)} USDC</span>
        </div>
      </div>
      <Meter value={fill} tone={bar} className="h-1.5" />
    </div>
  );
}

/** A clock for countdowns between the 5 s reads of the loan. */
function useClock() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function LiquidateStep({ me, journey, readAt, go }: { me: Me; journey: Journey; readAt: number; go: Go }) {
  const { address, write } = useWallet();
  const now = useClock();
  const p = me.position;
  const left = secondsLeft(me);
  const elapsed = now === 0 ? 0 : Math.max(0, Math.floor((now - readAt) / 1000));
  const leftNow = left === null ? null : left - elapsed;
  const over = p.debt > p.maxDebt || (leftNow !== null && leftNow <= 0);
  const max = maxBorrow(me);
  const then = "The vault hedges your stock on HyperCore, then sells it back through the Uniswap v4 hook.";

  async function repay() {
    if (me.allowance.usdcMorpho < p.debt + 1n) {
      if (!(await write("Approve USDC", dep.usdc, erc20Abi, "approve", [dep.morpho, maxUint256]))) return;
    }
    if (await write("Repay", dep.morpho, iMorphoAbi, "repay", [me.market.params, 0n, p.borrowShares, address, "0x"])) {
      journey.forgetLoan();
    }
  }

  if (journey.closing) {
    return (
      <Body
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-2 rounded-full bg-up animate-pulse-dot" /> Liquidated. Loading what happened…
          </span>
        }
        why="Your loan is closed: Seiz3's keeper liquidated it. The details show up as soon as the feed scans that block, usually a few seconds."
        then={then}
      >
        <Aside label="I repaid it myself, skip this" onClick={journey.forgetLoan} />
      </Body>
    );
  }

  if (p.debt < DUST) {
    return (
      <Body
        title="No open loan"
        why={`A liquidation needs a loan over its limit. Borrow the max and interest takes it over in seconds.${
          journey.latest ? ` Your last liquidation (${journey.latest.id}) is under “What happened to your loan”.` : ""
        }`}
        then={then}
      >
        <Action label={p.collateral > 0n ? "Go to Borrow" : "Go to Deposit"} onClick={() => go(p.collateral > 0n ? "borrow" : "deposit")} />
      </Body>
    );
  }

  if (over) {
    return (
      <Body
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-2 rounded-full bg-down animate-pulse-dot" /> Over the limit: being liquidated
          </span>
        }
        why="Seiz3's keeper is liquidating your loan now: the vault repays your debt to Morpho and takes your NVDAx at Morpho's discount. Usually within seconds; if it takes over a minute, check the keeper on the Dashboard."
        then={then}
      >
        <LoanMeter me={me} over />
      </Body>
    );
  }

  if (leftNow !== null && leftNow < 3600) {
    return (
      <Body
        title="Wait for the liquidation"
        why={`Interest is pushing your loan over the ${lltvPct(me)}% limit. When it crosses, Seiz3's keeper liquidates it within seconds.`}
        then={then}
      >
        <div className="flex items-baseline gap-3">
          <span className={`font-mono text-[34px] leading-none font-semibold ${leftNow < 60 ? "text-warn" : "text-foreground"}`}>
            ~{leftNow < 120 ? `${leftNow} s` : `${Math.ceil(leftNow / 60)} min`}
          </span>
          <span className="text-[12px] text-muted">until it crosses the limit, at today&apos;s price</span>
        </div>
        <LoanMeter me={me} over={false} />
        <Aside label="Changed your mind? Repay the loan" onClick={() => void repay()} />
      </Body>
    );
  }

  // borrowed well under the limit: nothing will happen soon
  return (
    <Body
      title="Your loan is safe for now"
      why={`You borrowed under the ${lltvPct(me)}% limit, so at this price it won't be liquidated any time soon. Borrow the rest to take it to the limit and see the liquidation.`}
      then={then}
    >
      <LoanMeter me={me} over={false} />
      <Action
        label={`Borrow the rest: ${fmt(max, 6, 2)} USDC`}
        onClick={() => write("Borrow USDC", dep.morpho, iMorphoAbi, "borrow", [me.market.params, max, 0n, address, address])}
        disabled={max === 0n}
      />
      <Aside label="Or repay the loan" onClick={() => void repay()} />
    </Body>
  );
}

function Check({ state, children, link }: { state: "done" | "now" | "wait"; children: ReactNode; link?: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3 py-2">
      <span
        className={`grid size-5 shrink-0 place-items-center self-center rounded-full font-mono text-[10px] font-semibold ${
          state === "done" ? "bg-up/15 text-up" : state === "now" ? "bg-brand/15 text-brand" : "bg-foreground/6 text-faint"
        }`}
      >
        {state === "done" ? "✓" : state === "now" ? <span className="size-1.5 rounded-full bg-brand animate-pulse-dot" /> : "·"}
      </span>
      <span className={`min-w-0 flex-1 text-[13px] ${state === "wait" ? "text-faint" : ""}`}>{children}</span>
      {link}
    </li>
  );
}

/** Whether any of this liquidation's stock went straight to a buyer through the hook. */
function soldToBuyer(op: Operation, operations: Operation[]): boolean {
  const ids = new Set(op.lots.map((l) => l.opId));
  return operations.some((o) => ids.has(o.id) && o.soldTo === "buyer");
}

function UnwindStep({
  op,
  operations,
  journey,
  onRole,
}: {
  op: Operation;
  operations: Operation[];
  journey: Journey;
  onRole: (r: Role) => void;
}) {
  const total = nvdax(op.nvdax);
  const sold = total - nvdax(op.held);
  const finished = BigInt(op.held) === 0n;
  const hedged = op.confirmed !== null;
  const toBuyer = soldToBuyer(op, operations);
  return (
    <Body
      title={finished ? <span className="text-up">Your stock was sold ✓</span> : "Watch the vault sell your stock"}
      why={
        finished
          ? `All the NVDAx from ${op.id} is sold and the vault's HyperCore short is closed.`
          : "The vault took your NVDAx and shorted the same amount on HyperCore, so a price move can't hurt it. Now it sells the stock back: buyers get first pick through the Uniswap v4 hook, and the keeper sells the rest into the pool while its price is close to HyperCore's."
      }
      then={finished ? undefined : "Round complete. The full trace is under “What happened to your loan”."}
    >
      <ol className="flex flex-col divide-y divide-line rounded-[3px] border border-line bg-well px-3">
        <Check state="done" link={<TxLink hash={op.txHash} />}>
          Liquidated: the vault repaid {usd(op.usdc, 2)} of your debt and took {total.toFixed(4)} NVDAx
        </Check>
        <Check state={hedged ? "done" : "now"}>
          {hedged ? "Hedged" : "Hedging"}: short {total.toFixed(4)} NVDA on HyperCore{hedged ? "" : "…"}
        </Check>
        <Check state={finished ? "done" : hedged ? "now" : "wait"}>
          <span className="flex flex-col gap-1.5">
            <span>
              {finished ? "Sold" : "Selling"}: {sold.toFixed(4)} of {total.toFixed(4)} NVDAx sold
              {toBuyer ? ", some to a buyer through the hook" : ""}
            </span>
            <Meter value={total === 0 ? 0 : sold / total} tone={finished ? "bg-up" : "bg-brand"} />
          </span>
        </Check>
      </ol>
      {!finished && (
        <>
          <Action tone="plain" label="Be the buyer: buy NVDAx through the hook" onClick={() => onRole("buyer")} />
          {journey.step === "unwind" && <Aside label="Start another round meanwhile" onClick={journey.nextRound} />}
        </>
      )}
    </Body>
  );
}

function DoneStep({ op, operations, journey }: { op: Operation; operations: Operation[]; journey: Journey }) {
  const toBuyer = soldToBuyer(op, operations);
  return (
    <Body
      title={<span className="text-up">Round complete ✓</span>}
      why={`The vault sold all ${nvdax(op.nvdax).toFixed(4)} NVDAx it took from your loan${
        toBuyer ? ", part of it straight to a buyer through the Uniswap v4 hook," : ""
      } and bought back its HyperCore short. Morpho's lenders were repaid in full, and you kept the USDC.`}
      then="Run it again, or try one of the other roles."
    >
      <Action label="Run another round" onClick={journey.nextRound} />
    </Body>
  );
}

/** The step on show: the wallet's next one (picked by `useJourney`), or any other the person opened from the tabs. */
export function NextStep({
  me,
  journey,
  step,
  operations,
  readAt,
  go,
  onRole,
}: {
  me: Me | undefined;
  journey: Journey;
  step: StepKey;
  operations: Operation[];
  /** When `me` was read, for the countdown between reads. */
  readAt: number;
  go: Go;
  onRole: (r: Role) => void;
}) {
  const { address, onChain } = useWallet();
  const { latest } = journey;
  const isNext = step === journey.step;
  const index = STEPS.findIndex((s) => s.key === step);

  let body: ReactNode;
  if (step === "connect") body = <ConnectStep go={go} />;
  else if (step !== "done" && step !== "loading" && (address === null || !onChain)) {
    // a look at a later step before connecting
    body = (
      <Body title={PREVIEW[step].title} why={PREVIEW[step].why}>
        <ConnectAction />
      </Body>
    );
  } else if (!me) body = <Body title="Reading your wallet…" why={`Balances and loan from ${CHAIN_LABEL}.`} />;
  else if (step === "faucet") body = <FaucetStep me={me} onRole={onRole} />;
  else if (step === "deposit") body = <DepositStep me={me} go={go} />;
  else if (step === "borrow") body = <BorrowStep me={me} go={go} onRole={onRole} />;
  else if (step === "liquidate") body = <LiquidateStep me={me} journey={journey} readAt={readAt} go={go} />;
  else if (step === "unwind") {
    body = latest ? (
      <UnwindStep op={latest} operations={operations} journey={journey} onRole={onRole} />
    ) : (
      <Body title="Nothing to unwind yet" why="Once your loan is liquidated, the vault's sale of your stock shows up here, step by step.">
        <Action label="Go to your next step" onClick={() => go()} />
      </Body>
    );
  } else if (step === "done" && latest) body = <DoneStep op={latest} operations={operations} journey={journey} />;

  return (
    <Panel
      accent={isNext}
      title={
        isNext ? (
          <span className="text-brand">Your next step</span>
        ) : (
          <span>
            Step {index + 1} · {STEPS[index]?.label}
          </span>
        )
      }
      meta={
        isNext ? (
          index >= 0 ? (
            <span>
              step {index + 1} of {STEPS.length}
            </span>
          ) : step === "done" ? (
            <span>all steps done</span>
          ) : null
        ) : (
          <button type="button" onClick={() => go()} className="normal-case text-brand hover:underline">
            ← back to your next step
          </button>
        )
      }
      bodyClassName="flex flex-col gap-4 p-4 sm:p-5"
    >
      {body}
    </Panel>
  );
}
