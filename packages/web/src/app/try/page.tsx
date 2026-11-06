import { TopBar } from "@/components/TopBar";
import { TryPage } from "@/components/try/TryPage";

export const metadata = { title: "Try Afterbell · testnet" };

export default function Try() {
  return (
    <>
      <TopBar active="try" />
      <main className="mx-auto w-full max-w-[1440px] px-3 py-3 sm:px-4">
        <TryPage />
      </main>
    </>
  );
}
