import { Suspense } from "react";
import { TopBar } from "@/components/TopBar";
import { TxView } from "@/components/TxView";

export const metadata = { title: "Transaction · Seiz3" };

// the hash is only known at request time, so the view (useParams) sits under Suspense for the prerender
export default function Tx() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-5xl px-3 py-3 sm:px-4">
        <Suspense fallback={<p className="font-mono text-[12px] text-muted">Loading transaction…</p>}>
          <TxView />
        </Suspense>
      </main>
    </>
  );
}
