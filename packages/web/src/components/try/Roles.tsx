"use client";

import type { Me } from "@/lib/me";
import { Panel, Tag } from "../ui";
import type { Role } from "./journey";
import { LendCard } from "./LendCard";
import { SwapCard } from "./SwapCard";
import { Bare } from "./ui";
import { VaultCard } from "./VaultCard";

const ROLES: { key: Role; name: string; venue: string; text: string }[] = [
  {
    key: "lender",
    name: "Lender",
    venue: "Morpho",
    text: "Lend USDC to borrowers like you and earn interest. Seiz3 is what keeps their bad loans from costing you.",
  },
  {
    key: "vault",
    name: "Vault LP",
    venue: "Seiz3",
    text: "Fund the vault that buys liquidated stock at a discount and hedges it on HyperCore.",
  },
  {
    key: "buyer",
    name: "Buyer",
    venue: "Uniswap v4",
    text: "Buy or sell NVDAx. The hook fills a buy from the vault's liquidated stock first.",
  },
];

/** The other sides of the same market, one open at a time. None of them is needed for the borrower's steps. */
export function Roles({ me, role, onRole }: { me: Me | undefined; role: Role | null; onRole: (r: Role | null) => void }) {
  return (
    <Panel title="Other roles" meta={<span>optional</span>} bodyClassName="flex flex-col divide-y divide-line">
      <p className="px-3 py-2.5 text-[12px] text-muted">
        The steps only need you as the borrower. These are the other people in the same story; open one to try it.
      </p>
      {ROLES.map((r) => {
        const open = role === r.key;
        return (
          <div key={r.key} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onRole(open ? null : r.key)}
              className={`flex items-start gap-3 px-3 py-2.5 text-left hover:bg-raised ${open ? "bg-raised" : ""}`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {r.name} <Tag>{r.venue}</Tag>
                </span>
                <span className="text-[11.5px] leading-snug text-faint">{r.text}</span>
              </div>
              <span className={`pt-0.5 font-mono text-[13px] text-muted transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            </button>
            {open && (
              <div className="border-t border-line bg-well/60 p-3">
                <Bare>
                  {r.key === "lender" && <LendCard me={me} />}
                  {r.key === "vault" && <VaultCard me={me} />}
                  {r.key === "buyer" && <SwapCard me={me} />}
                </Bare>
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}
