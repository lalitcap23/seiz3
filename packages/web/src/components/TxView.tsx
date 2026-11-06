"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";
import { dep } from "@/lib/chain";
import { describe } from "./ActivityFeed";
import { KV, Panel, Tag } from "./ui";

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

const VAULT_EVENTS = new Set([
  "LiquidationTaken",
  "HedgeSent",
  "HedgeConfirmed",
  "HedgeStuck",
  "Unwound",
  "MarginMoved",
  "InventoryFill",
]);
const DECIMALS: Record<string, number> = { USDC: 6, NVDAx: 18 };

/** One event in words where we know it, the raw fields otherwise. `hookFill`: the tx holds the hook's InventoryFill. */
function line(e: TxViewData["events"][number], hookFill: boolean): string {
  if (VAULT_EVENTS.has(e.name)) {
    return describe({ type: e.name as never, args: e.args }, dep.hypercore.szDecimals, hookFill ? "buyer" : "pool").text;
  }
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
    return (
      <p className={`font-mono text-[12px] ${error ? "text-down" : "text-muted"}`}>
        {error ? String(error.message) : "Loading transaction…"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Panel
        title={
          <>
            Transaction <Tag tone={data.status === "success" ? "up" : "down"}>{data.status}</Tag>
          </>
        }
        meta={
          <Link href="/" className="hover:text-foreground">
            ← dashboard
          </Link>
        }
      >
        <p className="mb-2 font-mono text-[12px] break-all text-foreground">{data.hash}</p>
        <KV
          rows={[
            [
              "Block",
              <span key="block" suppressHydrationWarning>
                {data.blockNumber} · {new Date(data.timestamp).toLocaleString()}
              </span>,
            ],
            ["From", <span key="from" className="break-all">{data.from}</span>],
            [
              "To",
              <span key="to" className="break-all">
                {data.toName && <span className="mr-2 font-sans text-foreground">{data.toName}</span>}
                <span className="text-muted">{data.to}</span>
              </span>,
            ],
            ["Called", data.call ? `${data.call.name}(…)` : "–"],
            ["Gas used", Number(data.gasUsed).toLocaleString()],
          ]}
        />
      </Panel>

      <Panel title={<span className="text-evm">HyperEVM · events</span>} meta={<span>{data.events.length}</span>} bodyClassName="">
        {data.events.length === 0 && <p className="px-3 py-4 font-mono text-[12px] text-faint">No events.</p>}
        <ol className="flex flex-col">
          {data.events.map((e, i) => (
            <li key={i} className="grid gap-x-3 gap-y-0.5 border-b border-line/60 px-3 py-2 last:border-b-0 md:grid-cols-[14rem_1fr]">
              <span className="font-mono text-[11px] text-faint">
                {e.contract ?? short(e.address)} · <span className="text-muted">{e.name}</span>
              </span>
              <span className="text-[12px]">{line(e, data.events.some((x) => x.name === "InventoryFill"))}</span>
            </li>
          ))}
        </ol>
      </Panel>

      {data.hypercore.length > 0 && (
        <Panel
          title={<span className="text-core">HyperCore · orders</span>}
          meta={
            data.hypercoreExplorer && (
              <a className="hover:text-foreground" href={data.hypercoreExplorer} target="_blank" rel="noreferrer">
                vault account ↗
              </a>
            )
          }
          bodyClassName=""
        >
          <ol className="flex flex-col">
            {data.hypercore.map((o) => (
              <li key={o.cloid} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3 py-2 text-[12px] last:border-b-0">
                <Tag tone={o.side === "sell" ? "down" : "up"}>{o.side === "sell" ? "short" : "buy-back"}</Tag>
                <span>
                  The vault&apos;s IOC of <span className="font-mono">{o.size}</span> NVDA
                </span>
                <span className={`font-mono text-[11px] ${o.status === "filled" ? "text-up" : "text-warn"}`}>{o.status}</span>
                {o.fills.map((f, i) =>
                  data.hypercoreTxExplorer ? (
                    <a
                      key={i}
                      className="font-mono text-[11px] text-muted hover:text-foreground"
                      href={`${data.hypercoreTxExplorer}${f.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {f.sz} @ ${f.px} ↗
                    </a>
                  ) : (
                    <span key={i} className="font-mono text-[11px] text-muted">
                      {f.sz} @ ${f.px}
                    </span>
                  ),
                )}
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </div>
  );
}
