"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { MarketName } from "@seiz3/shared";
import { riskParamsAbi, seiz3HookRemoteAbi } from "@seiz3/shared/abis";
import { useSnapshot } from "@/lib/api";
import { dep, EVM_EXPLORER, extraAddresses, HL_ACCOUNT_URL, publicClient } from "@/lib/chain";
import { nvdax, price } from "@/lib/format";
import { SoldToTag } from "./OperationCard";
import { Label, Panel, Tag, type Tone } from "./ui";

// ─── numbers ─────────────────────────────────────────────────────────────

/** Morpho Blue's liquidation incentive factor: min(1.15, 1 / (1 − 0.3 × (1 − LLTV))). */
const incentive = (lltv: number) => Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
/** Basis points → "0.10%", "…" until the chain read lands. */
const bps = (v: number | undefined) => (v === undefined ? "…" : `${(v / 100).toFixed(2)}%`);
/** v4 LP fee in pips → "0.30%". */
const pips = (v: number | undefined) => (v === undefined ? "…" : `${(v / 10_000).toFixed(2)}%`);

/** The hook's settings and the vault's risk parameters, read from the chain so the page quotes what is live. */
function useParams() {
  return useQuery({
    queryKey: ["howParams"],
    staleTime: 60_000,
    queryFn: async () => {
      const [risk, settings] = await Promise.all([
        publicClient.readContract({ address: dep.riskParams, abi: riskParamsAbi, functionName: "get" }),
        dep.hook
          ? publicClient.readContract({ address: dep.hook, abi: seiz3HookRemoteAbi, functionName: "settings" })
          : Promise.resolve(null),
      ]);
      return { risk, settings };
    },
  });
}

// ─── small pieces ────────────────────────────────────────────────────────

/** Label/value rows whose values wrap (KV truncates). */
function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4">
      {rows.map(([k, v], i) => (
        <div key={i} className="col-span-2 grid grid-cols-subgrid border-b border-line/70 py-[7px] last:border-b-0">
          <dt className="text-[12px] text-muted">{k}</dt>
          <dd className="text-right font-mono text-[12px]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Addr({ address }: { address: Address }) {
  return (
    <a
      href={`${EVM_EXPLORER}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      title="Open on Basescan"
      className="break-all font-mono text-[12px] text-foreground hover:text-brand"
    >
      {address} <span className="text-faint">↗</span>
    </a>
  );
}

const TH = "py-1.5 pr-3 font-normal text-faint";
const TD = "py-2 pr-3 align-top";

// ─── 1. lending ──────────────────────────────────────────────────────────

const MARKETS: { key: MarketName; name: string; tag: string; tone: Tone; liquidator: string }[] = [
  { key: "A_naive", name: "Market A", tag: "naive", tone: "muted", liquidator: "Dumps the stock into a thin pool at any price" },
  { key: "B_conservative", name: "Market B", tag: "conservative", tone: "muted", liquidator: "Low limit: loans rarely get near it" },
  { key: "C_seiz3", name: "Market C", tag: "seiz3", tone: "brand", liquidator: "The Seiz3 vault: buys the stock and shorts it on HyperCore" },
];

/** 0 → 100% LTV in three zones (safe, liquidatable, bad debt), with the example loan marked. */
function LtvScale({ ltv, lltv, badAt }: { ltv: number; lltv: number; badAt: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="relative pt-5">
        <div
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-foreground"
          style={{ left: `${Math.min(92, Math.max(8, ltv * 100))}%` }}
        >
          this loan {pct(ltv)}
        </div>
        <div className="absolute top-4 h-4 w-px bg-foreground" style={{ left: `${ltv * 100}%` }} />
        <div className="flex h-2 overflow-hidden rounded-full">
          <div className="bg-up/50" style={{ width: `${lltv * 100}%` }} />
          <div className="bg-warn/60" style={{ width: `${(badAt - lltv) * 100}%` }} />
          <div className="flex-1 bg-down/60" />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-[1px] bg-up/50" />
          safe · 0–{pct(lltv, 0)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-[1px] bg-warn/60" />
          liquidatable · {pct(lltv, 0)}–{pct(badAt, 0)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-[1px] bg-down/60" />
          bad debt · over {pct(badAt, 0)}
        </span>
      </div>
    </div>
  );
}

/** A 10 NVDAx loan in market C at the live price: its limit, where it gets liquidated, where it turns into bad debt. */
function Example({ lltv, px }: { lltv: number; px: number | null }) {
  const units = 10;
  const p = px ?? 200;
  const value = units * p;
  const debt = Math.floor((value * 0.7) / 50) * 50;
  const ltv = debt / value;
  const lif = incentive(lltv);
  const liqPx = debt / (units * lltv);
  const badPx = (debt * lif) / units;
  return (
    <div className="flex flex-col gap-3 rounded-[3px] border border-line bg-well p-3">
      <Label>Example · market C{px === null ? " · example price" : " · live price"}</Label>
      <Facts
        rows={[
          ["Collateral", `${units} NVDAx × ${price(p)} = ${price(value)}`],
          [`Max borrow at the ${pct(lltv, 0)} LLTV`, price(value * lltv)],
          ["Borrowed", `${price(debt)} → LTV ${pct(ltv)}`],
          ["Liquidatable if NVDA falls to", `${price(liqPx)} (−${pct(1 - liqPx / p)})`],
          ["Bad debt if NVDA falls to", `${price(badPx)} (−${pct(1 - badPx / p)})`],
        ]}
      />
      <LtvScale ltv={ltv} lltv={lltv} badAt={1 / lif} />
      <p className="text-[12px] text-muted">
        Below {price(badPx)} the stock is worth less than the debt plus the liquidator&apos;s {pct(lif - 1)} bonus. No
        liquidator can repay it all, and the lenders take the loss.
      </p>
    </div>
  );
}

function Lending() {
  const { data } = useSnapshot();
  const params = useParams();
  const rows = MARKETS.map((m) => {
    const live = data?.markets.find((x) => x.name === m.key);
    const deployed = dep.markets?.[m.key];
    const lltv = live?.lltv ?? (deployed ? Number(BigInt(deployed.lltv)) / 1e18 : 0);
    return { ...m, lltv, px: live?.oraclePrice ?? null };
  }).filter((m) => m.lltv > 0);
  const c = rows.find((m) => m.key === "C_seiz3");

  return (
    <Panel title="1 · Lending: LTV and LLTV" meta={<span>Morpho Blue</span>} bodyClassName="grid gap-4 p-3 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3 text-[13px] leading-relaxed">
        <p>
          <span className="font-mono text-brand">LTV</span> (loan-to-value) is where a loan stands now:{" "}
          <span className="font-mono text-[12px]">debt ÷ (collateral × price)</span>. It rises when the borrower takes
          more, when interest accrues, or when the price falls.
        </p>
        <p>
          <span className="font-mono text-brand">LLTV</span> (liquidation LTV) is the market&apos;s fixed limit. Once a
          loan&apos;s LTV is past it, anyone can liquidate it: repay some or all of the debt and take the collateral at
          a discount, the liquidator&apos;s bonus.
        </p>
        <p className="text-muted">
          Liquidation price = <span className="font-mono text-[12px]">debt ÷ (collateral × LLTV)</span>. On Morpho you
          can borrow right up to the LLTV, with no lower borrowing limit as on Aave, so interest alone can tip a full
          loan over. That&apos;s what the Try it page does.
        </p>
        {c && <Example lltv={c.lltv} px={c.px} />}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] text-left text-[12px]">
            <thead className="font-mono text-[10px] uppercase">
              <tr>
                <th className={TH}>Market</th>
                <th className={`${TH} text-right`}>LLTV</th>
                <th className={`${TH} text-right`}>Bonus</th>
                <th className={`${TH} text-right`}>Bad debt past</th>
                <th className={TH}>Who liquidates</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const lif = incentive(m.lltv);
                return (
                  <tr key={m.key} className="border-t border-line/60">
                    <td className={TD}>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        {m.name} <Tag tone={m.tone}>{m.tag}</Tag>
                      </span>
                    </td>
                    <td className={`${TD} text-right font-mono`}>{pct(m.lltv)}</td>
                    <td className={`${TD} text-right font-mono`}>{pct(lif - 1)}</td>
                    <td className={`${TD} text-right font-mono`}>{pct(1 / lif)} LTV</td>
                    <td className={`${TD} text-muted`}>{m.liquidator}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="rounded-[3px] border border-line bg-well p-3 text-[12px] leading-relaxed text-muted">
          <p>
            <span className="text-foreground">Bonus</span> is Morpho&apos;s liquidation incentive, set by the LLTV:{" "}
            <span className="font-mono">min(15%, 1 ÷ (1 − 0.3 × (1 − LLTV)) − 1)</span>. A lower LLTV pays a bigger
            bonus and leaves more room before bad debt.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Bad debt past</span> is the LTV where the collateral no longer covers
            the debt plus that bonus. The Seiz3 vault also refuses any liquidation with less than a{" "}
            {bps(params.data?.risk.minDiscountBps)} discount.
          </p>
        </div>
        <div className="rounded-[3px] border border-warn/30 bg-warn/5 p-3 text-[12px] leading-relaxed text-muted">
          <span className="text-warn">Why it matters after the bell:</span> NYSE closes, but NVDAx keeps trading
          on-chain in thin pools. A weekend price gap pushes loans past the LLTV when nobody can sell the stock at a
          fair price. Market A&apos;s liquidator dumps it and creates bad debt. Seiz3 hedges the stock on HyperCore
          straight away and sells it slowly.
        </div>
      </div>
    </Panel>
  );
}

// ─── 2. unwinding ────────────────────────────────────────────────────────

type Move = { from: string; to: string; token: "USDC" | "NVDAx"; note: string };

function Moves({ moves }: { moves: Move[] }) {
  return (
    <ol className="flex flex-col">
      {moves.map((m, i) => (
        <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 border-b border-line/70 py-2 last:border-b-0">
          <span className="font-mono text-[11px] text-brand">{i + 1}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
              <span>{m.from}</span>
              <span className="text-faint">→</span>
              <span>{m.to}</span>
              <Tag>{m.token}</Tag>
            </div>
            <span className="text-[12px] text-muted">{m.note}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Flow({
  tag,
  title,
  who,
  moves,
  after,
  terms,
  now,
}: {
  tag: ReactNode;
  title: string;
  who: ReactNode;
  moves: Move[];
  after: [ReactNode, ReactNode][];
  terms: [ReactNode, ReactNode][];
  now?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[3px] border border-line bg-well p-3">
      <div className="flex flex-wrap items-center gap-2">
        {tag}
        <span className="text-[13px] font-semibold">{title}</span>
      </div>
      <p className="text-[12px] leading-relaxed text-muted">{who}</p>
      <div>
        <Label>Token moves · all in one transaction</Label>
        <Moves moves={moves} />
      </div>
      <div>
        <Label>Afterwards</Label>
        <Facts rows={after} />
      </div>
      <div>
        <Label>Terms</Label>
        <Facts rows={terms} />
      </div>
      {now && <p className="font-mono text-[11px] text-faint">Now: {now}</p>}
    </div>
  );
}

const HOLDERS: { name: string; tone: Tone; tag: string; text: string }[] = [
  {
    name: "Seiz3VaultRemote",
    tone: "brand",
    tag: "holds the stock",
    text: "Holds the seized NVDAx and the USDC. Its stock is never added to the pool as liquidity: it leaves the vault only at the moment it's sold.",
  },
  {
    name: "Seiz3HookRemote",
    tone: "muted",
    tag: "holds nothing",
    text: "Holds no tokens, ever. It moves tokens inside a buyer's swap, and its balance in the PoolManager is back to zero before the swap ends.",
  },
  {
    name: "v4 PoolManager",
    tone: "evm",
    tag: "holds the curve",
    text: "Uniswap's singleton. Holds the curve's liquidity (the LP positions PoolSeeder owns). In a sale to a buyer it only passes tokens through.",
  },
];

function Unwinding() {
  const { data } = useSnapshot();
  const params = useParams();
  const risk = params.data?.risk;
  const s = params.data?.settings ?? undefined;
  const chunk = risk ? `${(Number(risk.maxUnhedged) / 10 ** dep.hypercore.szDecimals).toFixed(2)} NVDA` : "…";
  const hook = data?.hook ?? null;
  const oracle = data?.hyperliquid?.oraclePx ?? null;
  const hookNow =
    hook === null
      ? null
      : `ask ${price(hook.ask)} · ${
          BigInt(hook.capacity) > 0n ? `fills up to ${nvdax(hook.capacity).toFixed(3)} NVDAx` : "no fill available"
        } · market ${hook.open ? "open" : "closed"}`;
  const poolNow =
    data && oracle ? `pool ${price(data.pool.price)} vs HyperCore ${price(oracle)} (${pct(data.pool.price / oracle - 1, 2)})` : null;

  return (
    <Panel
      title="2 · Selling the seized stock: who holds the funds"
      meta={<span>Uniswap v4</span>}
      bodyClassName="flex flex-col gap-4 p-3"
    >
      <div className="grid gap-2 md:grid-cols-3">
        {HOLDERS.map((h) => (
          <div key={h.name} className="flex flex-col gap-2 rounded-[3px] border border-line bg-well p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px]">{h.name}</span>
              <Tag tone={h.tone}>{h.tag}</Tag>
            </div>
            <p className="text-[12px] leading-relaxed text-muted">{h.text}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Flow
          tag={<SoldToTag to="buyer" />}
          title="To a buyer, through the hook"
          who={
            <>
              Someone swaps USDC for NVDAx in the vault&apos;s pool. In <span className="font-mono">beforeSwap</span>{" "}
              the hook sells them the vault&apos;s stock at HyperCore&apos;s price plus a spread, off the curve. Whatever
              it doesn&apos;t fill goes to the curve.
            </>
          }
          moves={[
            { from: "PoolManager", to: "Vault", token: "USDC", note: "The PoolManager fronts the price (v4 flash accounting)" },
            { from: "Vault", to: "PoolManager", token: "NVDAx", note: "onHookFill: the vault sends the stock it sold" },
            { from: "Buyer", to: "PoolManager", token: "USDC", note: "The buyer pays, which repays step 1" },
            { from: "PoolManager", to: "Buyer", token: "NVDAx", note: "The buyer receives the stock" },
          ]}
          after={[
            ["Vault", "−NVDAx, +USDC"],
            ["Buyer", "+NVDAx, −USDC"],
            ["PoolManager, hook", "unchanged"],
            ["Curve liquidity", <span key="c" className="text-up">not used</span>],
          ]}
          terms={[
            ["Price", `HyperCore oracle + ${bps(s?.spreadOpenBps)} open / ${bps(s?.spreadClosedBps)} closed`],
            ["Only when", "the pool trades at or above that ask, so the buyer never pays more than the curve"],
            ["Size", `up to ${chunk} per fill`],
          ]}
          now={hookNow}
        />
        <Flow
          tag={<SoldToTag to="pool" />}
          title="Into the pool, by the keeper"
          who={
            <>
              The keeper calls <span className="font-mono">unwindStep()</span>. The vault sells one chunk into the
              curve, like any other swapper.
            </>
          }
          moves={[
            { from: "Vault", to: "PoolManager", token: "NVDAx", note: "Joins the curve's reserves" },
            { from: "PoolManager", to: "Vault", token: "USDC", note: "Paid out of the LP positions" },
          ]}
          after={[
            ["Vault", "−NVDAx, +USDC"],
            ["Sold NVDAx", "stays in the PoolManager, owned by the LPs"],
            ["Hook", "unchanged (it doesn't fill sells)"],
            ["Curve liquidity", <span key="c" className="text-warn">used</span>],
          ]}
          terms={[
            ["Price", `the curve's, ${pips(s?.feeOpen)} LP fee, price impact capped at ${bps(risk?.maxImpactBps)}`],
            ["Only when", `the pool is within ${bps(risk?.oracleBandBps)} of HyperCore and the cooldown has passed`],
            ["Size", `up to ${chunk} per step, at least HyperCore value − ${bps(risk?.maxSlippageBps)}`],
          ]}
          now={poolNow}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[12px]">
          <thead className="font-mono text-[10px] uppercase">
            <tr>
              <th className={TH}>Sale</th>
              <th className={TH}>Stock before</th>
              <th className={TH}>Stock after</th>
              <th className={TH}>USDC goes to</th>
              <th className={TH}>Curve liquidity</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line/60">
              <td className={TD}>
                <SoldToTag to="buyer" />
              </td>
              <td className={TD}>Vault</td>
              <td className={TD}>Buyer</td>
              <td className={TD}>Vault</td>
              <td className={`${TD} text-up`}>Not used</td>
            </tr>
            <tr className="border-t border-line/60">
              <td className={TD}>
                <SoldToTag to="pool" />
              </td>
              <td className={TD}>Vault</td>
              <td className={TD}>PoolManager (the LPs&apos; reserves)</td>
              <td className={TD}>Vault</td>
              <td className={`${TD} text-warn`}>Used</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="rounded-[3px] border border-line bg-well p-3 text-[12px] leading-relaxed text-muted">
        <span className="text-foreground">After either sale</span> the vault queues a reduce-only buy on HyperCore (
        <span className="font-mono">HyperCoreGateway.placeOrder</span>), the relayer places it from the hedge account,
        and the keeper&apos;s <span className="font-mono">syncHedge</span> confirms it. No other sale can happen until
        then, so the stock goes out one chunk at a time and the short shrinks with it.
      </p>
    </Panel>
  );
}

// ─── 3. who calls what ───────────────────────────────────────────────────

const CALLS: { actor: string; calls: string[]; why: string }[] = [
  {
    actor: "Buyer (you on Try it, or the demo bot)",
    calls: [
      "PoolSwapTest.swap → PoolManager.unlock → PoolManager.swap",
      "→ Seiz3HookRemote.beforeSwap → PoolManager.take / sync",
      "→ Seiz3VaultRemote.onHookFill → PoolManager.settle",
    ],
    why: "Buys NVDAx; the hook fills it from the vault",
  },
  {
    actor: "Keeper",
    calls: [
      "Seiz3VaultRemote.liquidate → Morpho.liquidate → onMorphoLiquidate",
      "Seiz3VaultRemote.unwindStep → PoolManager.unlock → unlockCallback → PoolManager.swap",
      "Seiz3VaultRemote.syncHedge",
    ],
    why: "Liquidates, pushes chunks into the pool, confirms each hedge",
  },
  {
    actor: "PoolManager",
    calls: ["Seiz3HookRemote.beforeInitialize / beforeSwap", "Seiz3VaultRemote.unlockCallback"],
    why: "v4 calls the hook on every swap in the vault's pool",
  },
  {
    actor: "Seiz3VaultRemote",
    calls: ["HyperCoreGateway.placeOrder"],
    why: "Queues the short after a liquidation, and the buy-back after a sale",
  },
  {
    actor: "Relayer",
    calls: ["IOC order on Hyperliquid", "HyperCoreGateway.relay(snapshot)"],
    why: "Places the vault's orders, reports the position back",
  },
  {
    actor: "Chainlink CRE",
    calls: ["HyperCoreGateway.onReport", "RiskParams.onReport"],
    why: "Independent snapshots of the hedge account; market hours",
  },
  {
    actor: "Pool bot",
    calls: ["PoolSeeder.swapToPrice → PoolManager.swap"],
    why: "Keeps the pool on HyperCore's price, as arbitrageurs would",
  },
  {
    actor: "Market A liquidator",
    calls: ["NaiveLiquidator.liquidate → Morpho.liquidate → swap on the thin pool"],
    why: "The comparison: dumps at any price, no hedge",
  },
];

function Calls() {
  return (
    <Panel title="3 · Who calls what" bodyClassName="overflow-x-auto px-3 pb-2">
      <table className="w-full min-w-[640px] text-left text-[12px]">
        <thead className="font-mono text-[10px] uppercase">
          <tr>
            <th className={TH}>Who</th>
            <th className={TH}>Calls</th>
            <th className={TH}>Why</th>
          </tr>
        </thead>
        <tbody>
          {CALLS.map((c) => (
            <tr key={c.actor} className="border-t border-line/60">
              <td className={`${TD} whitespace-nowrap`}>{c.actor}</td>
              <td className={`${TD} font-mono text-[11px]`}>
                {c.calls.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </td>
              <td className={`${TD} text-muted`}>{c.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ─── 4. contracts ────────────────────────────────────────────────────────

function Contracts() {
  const rows: [string, Address | undefined, string][] = [
    ["Seiz3VaultRemote", dep.vault, "ERC-4626 vault (abUSDC): liquidates, hedges, unwinds"],
    ["Seiz3HookRemote", dep.hook, "Uniswap v4 hook on the vault's pool"],
    ["HyperCoreGateway", dep.hyperCoreGateway, "The vault's orders out, HyperCore snapshots in"],
    ["RiskParams", dep.riskParams, "Limits, market hours (CRE)"],
    ["PoolSeeder", extraAddresses.poolSeeder, "Owns the LP positions; the pool bot's swaps"],
    ["NaiveLiquidator", extraAddresses.naiveLiquidator, "Market A's liquidator"],
    ["Faucet", dep.faucet, "Test tokens for Try it"],
    ["NVDAx", dep.nvdax, "Mock tokenised NVDA"],
    ["USDC", dep.usdc, "Mock USDC"],
    ["Uniswap v4 PoolManager", dep.poolManager, "Official"],
    ["Swap router", dep.swapRouter, "v4 PoolSwapTest"],
    ["Morpho Blue", dep.morpho, "Official"],
    ["Market A oracle", dep.markets?.A_naive.oracle, ""],
    ["Market B oracle", dep.markets?.B_conservative.oracle, ""],
    ["Market C oracle", dep.markets?.C_seiz3.oracle, ""],
    ["Chainlink CRE forwarder", extraAddresses.creForwarder, "Delivers CRE reports"],
    ["Relayer / hedge account", dep.hedgeAccount, "Holds the short on HyperCore"],
  ];
  return (
    <Panel
      title="4 · Contracts"
      meta={<span>Base Sepolia · {dep.chainId}</span>}
      bodyClassName="flex flex-col gap-3 px-3 pb-3"
    >
      <dl className="flex flex-col">
        {rows
          .filter((r): r is [string, Address, string] => r[1] !== undefined)
          .map(([name, address, note]) => (
            <div
              key={name}
              className="grid gap-x-4 gap-y-0.5 border-b border-line/70 py-2 last:border-b-0 md:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <dt className="text-[12px]">{name}</dt>
              <dd className="min-w-0">
                <Addr address={address} />
              </dd>
              <dd className="text-[12px] text-muted">
                {name === "Relayer / hedge account" ? (
                  <a href={HL_ACCOUNT_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">
                    {note} ↗
                  </a>
                ) : (
                  note
                )}
              </dd>
            </div>
          ))}
      </dl>
      <p className="text-[12px] leading-relaxed text-muted">
        Pools: the vault&apos;s USDC/NVDAx pool (fee set by the hook on every swap, tick spacing {dep.poolKey.tickSpacing},
        hook {dep.poolKey.hooks.slice(0, 6)}…{dep.poolKey.hooks.slice(-4)}), and market A&apos;s own pool (0.05% fee, no
        hook), so the naive dump never moves the vault&apos;s pool.
      </p>
    </Panel>
  );
}

// ─── page ────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "lending", label: "LTV & LLTV" },
  { id: "unwind", label: "Who holds the funds" },
  { id: "calls", label: "Who calls what" },
  { id: "contracts", label: "Contracts" },
] as const;

export function HowItWorks() {
  return (
    <div className="flex flex-col gap-2 pb-20">
      <section className="flex flex-col gap-2 rounded-[3px] border border-line bg-panel p-4 shadow-[inset_0_2px_0_var(--color-brand)]">
        <h1 className="text-[18px] font-semibold tracking-tight">How Seiz3 works</h1>
        <p className="max-w-[760px] text-[13px] leading-relaxed text-muted">
          A Morpho loan backed by tokenised NVDA goes past its limit. Instead of dumping the stock, the Seiz3 vault buys
          it, shorts the same amount on HyperCore so a price move can&apos;t hurt it, and sells it back through a Uniswap
          v4 hook.
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 pt-1 font-mono text-[11px]">
          {SECTIONS.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} className="text-muted hover:text-brand">
              <span className="text-brand">{i + 1}</span> {s.label}
            </a>
          ))}
        </nav>
      </section>
      <div id="lending" className="scroll-mt-14">
        <Lending />
      </div>
      <div id="unwind" className="scroll-mt-14">
        <Unwinding />
      </div>
      <div id="calls" className="scroll-mt-14">
        <Calls />
      </div>
      <div id="contracts" className="scroll-mt-14">
        <Contracts />
      </div>
    </div>
  );
}
