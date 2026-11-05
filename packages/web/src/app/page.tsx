import { Dashboard } from "@/components/Dashboard";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Afterbell</h1>
        <p className="text-sm opacity-60">
          Weekend liquidations, hedged on HyperCore, unwound on Uniswap v4
        </p>
      </header>
      <Dashboard />
    </main>
  );
}
