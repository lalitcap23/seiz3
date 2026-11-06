"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";
import { dep } from "@/lib/chain";
import { describe } from "./ActivityFeed";

interface TxViewData {
  hash: string;
  status: "success" | "reverted";
  blockNumber: string;
  timestamp: number;
  from: string;
  to: string | null;
  toName: string | null;
  call: { name: string; args: unknown } | null;
  gasUsed: string;
  events: { address: string; contract: string | null; name: string; args: Record<string, unknown> }[];
  hypercore: {
    cloid: string;
    side: "sell" | "buy";
    size: string;
    status: string;
    fills: { sz: string; px: string; time: number; hash: string }[];
  }[];
  hypercoreExplorer: string | null;
  hypercoreTxExplorer: string | null;
}

const VAULT_EVENTS = new Set(["LiquidationTaken", "HedgeSent", "HedgeConfirmed", "HedgeStuck", "Unwound", "MarginMoved"]);
const DECIMALS: Record<string, number> = { USDC: 6, NVDAx: 18 };

/** One event in words where we know it, the raw fields otherwise. */
function line(e: TxViewData["events"][number]): string {
  if (VAULT_EVENTS.has(e.name)) return describe({ type: e.name as never, args: e.args }, dep.hypercore.szDecimals).text;
  const a = e.args;
  const amount = (v: unknown, dec: number) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const who = (v: unknown) => short(String(v));
  if (e.name === "Transfer" && e.contract && DECIMALS[e.contract] !== undefined) {
    return `${amount(a.value, DECIMALS[e.contract])} ${e.contract}: ${who(a.from)} → ${who(a.to)}`;
  }
  if (e.name === "Liquidate") {
    return `Morpho liquidated ${who(a.borrower)}: repaid ${amount(a.repaidAssets, 6)} USDC, seized ${amount(a.seizedAssets, 18)} NVDAx, bad debt ${amount(a.badDebtAssets, 6)} USDC`;
  }
  if (e.name === "Borrow") return `Morpho: ${who(a.onBehalf)} borrowed ${amount(a.assets, 6)} USDC`;
  if (e.name === "SupplyCollateral") return `Morpho: ${who(a.onBehalf)} deposited ${amount(a.assets, 18)} NVDAx collateral`;
  if (e.name === "Repay") return `Morpho: ${who(a.onBehalf)} repaid ${amount(a.assets, 6)} USDC`;
  if (e.name === "Dripped") return `Faucet: ${amount(a.nvdax, 18)} NVDAx, ${amount(a.usdc, 6)} USDC, ${amount(a.native, 18)} HYPE to ${who(a.to)}`;
  return Object.entries(a)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") && v.length === 42 ? short(v) : String(v)}`)
    .join(", ");
}

const short = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

/** The /tx/<hash> page: HyperEVM testnet has no working public explorer, so the API decodes the tx for us. */
export function TxView() {
  const { hash } = useParams<{ hash: string }>();
  const { data, error } = useQuery({
    queryKey: ["tx", hash],
    queryFn: async (): Promise<TxViewData> => {
      const res = await fetch(`${API_URL}/tx/${hash}`);
      const body = (await res.json()) as TxViewData | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `tx ${res.status}`);
      return body;
    },
    retry: 20, // a tx just sent can take a few seconds to show up
    retryDelay: 2_000,
  });

  if (!data) {
    return <p className="text-sm opacity-60">{error ? String(error.message) : "Loading transaction…"}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-foreground/10 p-4 text-sm">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              data.status === "success" ? "bg-emerald-500/15 text-emerald-500" : "bg-red-500/15 text-red-500"
            }`}
          >
            {data.status}
          </span>
          <span className="font-mono text-xs break-all opacity-70">{data.hash}</span>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
          <dt className="opacity-60">Block</dt>
          <dd className="tabular-nums" suppressHydrationWarning>
            {data.blockNumber} · {new Date(data.timestamp).toLocaleString()}
          </dd>
          <dt className="opacity-60">From</dt>
          <dd className="font-mono text-xs break-all">{data.from}</dd>
          <dt className="opacity-60">To</dt>
          <dd>
            {data.toName ?? ""} <span className="font-mono text-xs break-all opacity-70">{data.to}</span>
          </dd>
          <dt className="opacity-60">Called</dt>
          <dd className="font-mono text-xs">{data.call ? `${data.call.name}(…)` : "–"}</dd>
          <dt className="opacity-60">Gas used</dt>
          <dd className="tabular-nums">{Number(data.gasUsed).toLocaleString()}</dd>
        </dl>
      </section>

      <section className="rounded-xl border border-foreground/10 p-4 text-sm">
        <h2 className="mb-2 font-semibold">What happened on HyperEVM</h2>
        {data.events.length === 0 && <p className="opacity-60">No events.</p>}
        <ol className="flex flex-col gap-1.5">
          {data.events.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-3">
              <span className="w-40 shrink-0 opacity-50">
                {e.contract ?? short(e.address)} · {e.name}
              </span>
              <span>{line(e)}</span>
            </li>
          ))}
        </ol>
      </section>

      {data.hypercore.length > 0 && (
        <section className="rounded-xl border border-violet-500/30 p-4 text-sm">
          <h2 className="mb-2 font-semibold">What happened on HyperCore</h2>
          <ol className="flex flex-col gap-1.5">
            {data.hypercore.map((o) => (
              <li key={o.cloid}>
                The vault&apos;s IOC <b>{o.side === "sell" ? "short" : "buy-back"}</b> of {o.size} NVDA:{" "}
                <span className={o.status === "filled" ? "text-emerald-500" : "text-amber-500"}>{o.status}</span>
                {o.fills.map((f, i) =>
                  data.hypercoreTxExplorer ? (
                    <a
                      key={i}
                      className="ml-2 tabular-nums underline opacity-80"
                      href={`${data.hypercoreTxExplorer}${f.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {f.sz} @ ${f.px} ↗
                    </a>
                  ) : (
                    <span key={i} className="ml-2 tabular-nums opacity-80">
                      {f.sz} @ ${f.px}
                    </span>
                  ),
                )}
              </li>
            ))}
          </ol>
          {data.hypercoreExplorer && (
            <a className="mt-2 inline-block text-xs underline opacity-70" href={data.hypercoreExplorer} target="_blank" rel="noreferrer">
              The vault&apos;s HyperCore account on Hyperliquid&apos;s explorer →
            </a>
          )}
        </section>
      )}

      <Link href="/" className="text-sm underline opacity-70">
        ← Dashboard
      </Link>
    </div>
  );
}
