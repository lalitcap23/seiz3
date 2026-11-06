"use client";

import Link from "next/link";
import { useLive, useSnapshot } from "@/lib/api";
import { NETWORK } from "@/lib/chain";

const TABS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "try", href: "/try", label: "Try it" },
] as const;

function Mark() {
  return (
    <span className="grid size-6 place-items-center rounded-[3px] bg-brand text-black">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
        <path d="M8 1.75a4.25 4.25 0 0 0-4.25 4.25v2.6L2.5 11h11l-1.25-2.4V6A4.25 4.25 0 0 0 8 1.75Z" />
        <path d="M6.25 12.25a1.75 1.75 0 0 0 3.5 0z" />
      </svg>
    </span>
  );
}

/** The app's nav: wordmark, pages, and whether the feed is live. */
export function TopBar({ active }: { active?: (typeof TABS)[number]["key"] }) {
  const live = useLive();
  const { data } = useSnapshot();
  const status = live.down
    ? { text: "Reconnecting", dot: "bg-warn", tone: "text-warn" }
    : live.apiError
      ? { text: "RPC error", dot: "bg-warn", tone: "text-warn" }
      : { text: "Live", dot: "bg-up animate-pulse-dot", tone: "text-muted" };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-4 px-3 sm:gap-6 sm:px-4">
        <Link href="/" className="flex items-center gap-2">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">afterbell</span>
        </Link>
        <nav className="flex h-full items-center">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={`relative flex h-full items-center px-3 text-[13px] ${
                t.key === active
                  ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-brand"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 font-mono text-[11px] uppercase">
          <span className={`flex items-center gap-1.5 ${status.tone}`}>
            <span className={`size-1.5 rounded-full ${status.dot}`} />
            {status.text}
          </span>
          {data && (
            <span className="hidden text-faint md:inline">
              Blk <span className="text-muted">{Number(data.blockNumber).toLocaleString("en-US")}</span>
            </span>
          )}
          <span className="hidden rounded-[2px] border border-line-strong px-2 py-0.5 text-muted sm:inline">
            HyperEVM {NETWORK}
          </span>
        </div>
      </div>
    </header>
  );
}
