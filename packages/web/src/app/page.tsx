import { Dashboard } from "@/components/Dashboard";
import { TopBar } from "@/components/TopBar";

export default function Home() {
  return (
    <>
      <TopBar active="dashboard" />
      <main className="mx-auto w-full max-w-[1440px] px-3 py-3 sm:px-4">
        <Dashboard />
      </main>
    </>
  );
}
