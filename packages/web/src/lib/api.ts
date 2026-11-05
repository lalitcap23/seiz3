"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { HistoryPoint, Snapshot } from "@afterbell/shared";
import fixture from "@afterbell/shared/fixtures/snapshot.json";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const USE_FIXTURE = process.env.NEXT_PUBLIC_USE_FIXTURE === "1";

/** Live snapshot: initial GET /snapshot, then pushed over SSE (/stream) into the query cache. */
export function useSnapshot() {
  const qc = useQueryClient();

  useEffect(() => {
    if (USE_FIXTURE) return;
    const es = new EventSource(`${API_URL}/stream`);
    es.addEventListener("snapshot", (e) =>
      qc.setQueryData(["snapshot"], JSON.parse(e.data) as Snapshot),
    );
    return () => es.close();
  }, [qc]);

  return useQuery({
    queryKey: ["snapshot"],
    queryFn: async (): Promise<Snapshot> => {
      if (USE_FIXTURE) return fixture as Snapshot;
      const res = await fetch(`${API_URL}/snapshot`);
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      return res.json();
    },
    placeholderData: fixture as Snapshot,
  });
}

export function useHistory(from = 0) {
  return useQuery({
    queryKey: ["history", from],
    queryFn: async (): Promise<HistoryPoint[]> => {
      if (USE_FIXTURE) return [];
      const res = await fetch(`${API_URL}/history?from=${from}`);
      if (!res.ok) throw new Error(`history ${res.status}`);
      return res.json();
    },
    refetchInterval: 2_000,
  });
}
