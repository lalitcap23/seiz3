import { HowItWorks } from "@/components/HowItWorks";
import { TopBar } from "@/components/TopBar";

export const metadata = { title: "How Seiz3 works" };

export default function How() {
  return (
    <>
      <TopBar active="how" />
      <main className="mx-auto w-full max-w-[1440px] px-3 py-3 sm:px-4">
        <HowItWorks />
      </main>
    </>
  );
}
