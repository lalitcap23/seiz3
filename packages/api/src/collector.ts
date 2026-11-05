import type { HistoryPoint, Snapshot } from "@afterbell/shared";
import fixture from "@afterbell/shared/fixtures/snapshot.json" with { type: "json" };

/** Polls HyperEVM (one multicall) + Hyperliquid info API every second; keeps latest snapshot in memory. */
export class Collector {
  latest: Snapshot = fixture as Snapshot; // serve the fixture until the first real poll lands
  history: HistoryPoint[] = [];
  private listeners = new Set<(s: Snapshot) => void>();

  start(intervalMs = 1000) {
    setInterval(() => void this.poll(), intervalMs);
  }

  subscribe(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async poll() {
    try {
      // TODO: multicall Morpho markets + vault getters + v4 slot0; HL clearinghouseState(dex:"xyz"); vault event logs
      this.latest = { ...this.latest, updatedAt: Date.now() };
      this.history.push({
        t: this.latest.updatedAt,
        inventory: Number(this.latest.vault.inventory) / 1e18,
        short: Number(this.latest.vault.confirmedShort),
        hedgeRatio: this.latest.vault.hedgeRatio,
        sharePrice: this.latest.vault.sharePrice,
      });
      if (this.history.length > 3600) this.history.shift();
      for (const fn of this.listeners) fn(this.latest);
    } catch (err) {
      console.error("[api] poll failed", err);
    }
  }
}
