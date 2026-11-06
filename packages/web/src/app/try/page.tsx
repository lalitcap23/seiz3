import Link from "next/link";
import { TryPage } from "@/components/try/TryPage";

export const metadata = { title: "Try Afterbell · testnet" };

export default function Try() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Try Afterbell</h1>
          <p className="text-sm opacity-60">
            HyperEVM testnet. Get test tokens, borrow at the limit, and watch the vault liquidate and hedge you.
          </p>
        </div>
        <Link href="/" className="text-sm underline opacity-70">
          Live dashboard →
        </Link>
      </header>
      <TryPage />
    </main>
  );
}
