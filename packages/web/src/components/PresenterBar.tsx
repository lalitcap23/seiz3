"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { API_URL } from "@/lib/api";

const STEPS = [
  { step: "reset", label: "Reset" },
  { step: "scene", label: "1 · Weekend gap" },
  { step: "marketA", label: "2 · Market A" },
  { step: "marketB", label: "3 · Market B" },
  { step: "marketC", label: "4 · Market C" },
  { step: "monday", label: "5 · Monday" },
] as const;

const noSubscribe = () => () => {};
const tokenFromUrl = () => new URLSearchParams(window.location.search).get("presenter");

/** The presenter's clicker: shown only with ?presenter=<REPLAY_TOKEN> in the URL. → or space runs the next step. */
export function PresenterBar() {
  const token = useSyncExternalStore(noSubscribe, tokenFromUrl, () => null);
  const [running, setRunning] = useState<string | null>(null);
  const [next, setNext] = useState(1);
  const [last, setLast] = useState("");

  async function run(step: string) {
    if (token === null || running !== null) return;
    setRunning(step);
    try {
      const res = await fetch(`${API_URL}/replay/${step}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { output?: string; error?: string };
      const lines = (body.output ?? body.error ?? "")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("[replay]") && !l.includes(".env"));
      setLast(`${res.ok ? "✓" : "✗"} ${step}: ${lines.at(-1)?.trim() ?? ""}`);
      if (res.ok) {
        const i = STEPS.findIndex((s) => s.step === step);
        setNext(i === STEPS.length - 1 ? 0 : i + 1);
      }
    } catch (error) {
      setLast(`✗ ${step}: ${String(error)}`);
    } finally {
      setRunning(null);
    }
  }

  useEffect(() => {
    if (token === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== " ") return;
      e.preventDefault();
      void run(STEPS[next]?.step ?? "reset");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (token === null) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-foreground/10 bg-background/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s.step}
            type="button"
            disabled={running !== null}
            onClick={() => void run(s.step)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
              i === next ? "bg-emerald-500 text-white" : "bg-foreground/10"
            }`}
          >
            {running === s.step ? `${s.label}…` : s.label}
          </button>
        ))}
        <span className="ml-auto max-w-md truncate text-xs opacity-70">{running ? `running ${running}…` : last}</span>
      </div>
    </div>
  );
}
