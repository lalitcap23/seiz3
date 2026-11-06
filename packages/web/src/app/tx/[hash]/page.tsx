import { Suspense } from "react";
import { TxView } from "@/components/TxView";

export const metadata = { title: "Transaction · Afterbell" };

// the hash is only known at request time, so the view (useParams) sits under Suspense for the prerender
export default function Tx() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="mb-4 text-xl font-bold">Transaction</h1>
      <Suspense fallback={<p className="text-sm opacity-60">Loading transaction…</p>}>
        <TxView />
      </Suspense>
    </main>
  );
}
