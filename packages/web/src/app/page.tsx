import Link from "next/link";
import { Dashboard } from "@/components/Dashboard";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Afterbell</h1>
          <p className="text-sm opacity-60">
            Weekend liquidations, hedged on HyperCore, unwound on Uniswap v4
          </p>
        </div>
        <Link href="/try" className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white">
          Try it on testnet →
        </Link>
      </header>
      <Dashboard />
    </main>
  );
}
