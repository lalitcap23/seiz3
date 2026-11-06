import { readFileSync } from "node:fs";

import type { Address } from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * deployments/watch.json, written by the API: everyone who connected on /try or took a faucet drip, newest first.
 * Read every tick (a missing or half-written file just means no extra borrowers this tick).
 */
export function readWatchlist(path: string | null): Address[] {
  if (path === null) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((a): a is Address => typeof a === "string" && ADDRESS.test(a)) : [];
  } catch {
    return [];
  }
}
