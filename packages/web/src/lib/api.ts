"use client";

import { replaceEqualDeep, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { HistoryPoint, Snapshot } from "@afterbell/shared";
import fixtureJson from "@afterbell/shared/fixtures/snapshot.json";
// a subpath, not the package root: Turbopack can't resolve the root's "./x.js" re-exports to TS sources
import { snapshotSchema } from "@afterbell/shared/types";

/** The demo snapshot, with the schema's defaults for fields added after it was recorded. */
const fixture = snapshotSchema.parse(fixtureJson);

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const USE_FIXTURE = process.env.NEXT_PUBLIC_USE_FIXTURE === "1";

/** The API sends a snapshot every second and a heartbeat every 5 s: this long without either, the stream is dead. */
const SILENT_MS = 12_000;
/** While the stream is down, the page polls GET /snapshot instead. */
const POLL_MS = 3_000;

/** How the live feed stands, for the dashboard's banner. */
export interface Live {
  /** No stream right now: reconnecting, and polling meanwhile. */
  down: boolean;
  /** When this browser last got a snapshot, on its own clock. */
  receivedAt: number | null;
  /** The API's own poll error from its heartbeat: it's up, but can't read the chain. */
  apiError: string | null;
}

let live: Live = { down: false, receivedAt: null, apiError: null };
const liveWatchers = new Set<() => void>();
function setLive(patch: Partial<Live>) {
  live = { ...live, ...patch };
  for (const w of liveWatchers) w();
}

export function useLive(): Live {
  return useSyncExternalStore(
    (w) => (liveWatchers.add(w), () => void liveWatchers.delete(w)),
    () => live,
    () => live,
  );
}

/** Snapshots arrive from the stream and from GETs: a slow GET answering after a newer push must not roll it back. */
function keepNewer(old: unknown, next: unknown): unknown {
  const a = old as Snapshot | undefined;
  const b = next as Snapshot;
  return a !== undefined && a.updatedAt > b.updatedAt ? a : replaceEqualDeep(a, b);
}

/**
 * One EventSource per page, however many components read the snapshot: browsers allow 6 connections per host across
 * every tab, and a page with one stream per component used them up, after which every request to the API hung.
 */
let users = 0;
let close: (() => void) | null = null;

function connect(qc: QueryClient): () => void {
  let es: EventSource | null = null;
  let heardAt = Date.now();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 1_000;

  const open = () => {
    es?.close();
    heardAt = Date.now();
    es = new EventSource(`${API_URL}/stream`);
    es.onopen = () => {
      delay = 1_000;
    };
    es.addEventListener("snapshot", (e) => {
      heardAt = Date.now();
      qc.setQueryData(["snapshot"], JSON.parse(e.data) as Snapshot);
      setLive({ down: false, receivedAt: Date.now(), apiError: null });
    });
    es.addEventListener("health", (e) => {
      heardAt = Date.now();
      setLive({ down: false, apiError: (JSON.parse(e.data) as { lastError: string | null }).lastError });
    });
    es.onerror = () => {
      setLive({ down: true });
      // the browser retries a dropped stream itself, but never after an HTTP error (a proxy's 502): that's on us
      if (es?.readyState === EventSource.CLOSED) reopen();
    };
  };
  const reopen = () => {
    if (retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
    delay = Math.min(delay * 2, 15_000);
  };
  // a stream can die without an error event (laptop sleep, a proxy dropping it): silence is the only sign
  const watchdog = setInterval(() => {
    if (Date.now() - heardAt < SILENT_MS) return;
    setLive({ down: true });
    reopen();
  }, 2_000);

  open();
  return () => {
    clearInterval(watchdog);
    if (retry !== null) clearTimeout(retry);
    es?.close();
  };
}

/** Live snapshot: pushed over SSE (/stream) into the query cache, with GET /snapshot first and while the stream is down. */
export function useSnapshot() {
  const qc = useQueryClient();
  const { down } = useLive();

  useEffect(() => {
    if (USE_FIXTURE) return;
    if (users++ === 0) close = connect(qc);
    return () => {
      if (--users === 0) {
        close?.();
        close = null;
      }
    };
  }, [qc]);

  return useQuery({
    queryKey: ["snapshot"],
    queryFn: async (): Promise<Snapshot> => {
      if (USE_FIXTURE) return fixture;
      const res = await fetch(`${API_URL}/snapshot`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const snapshot = (await res.json()) as Snapshot;
      setLive({ receivedAt: Date.now() });
      return snapshot;
    },
    placeholderData: fixture,
    refetchInterval: !USE_FIXTURE && down ? POLL_MS : false,
    structuralSharing: keepNewer,
  });
}

export function useHistory(from = 0) {
  return useQuery({
    queryKey: ["history", from],
    queryFn: async (): Promise<HistoryPoint[]> => {
      if (USE_FIXTURE) return [];
      const res = await fetch(`${API_URL}/history?from=${from}`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`history ${res.status}`);
      return res.json();
    },
    refetchInterval: 2_000,
  });
}
