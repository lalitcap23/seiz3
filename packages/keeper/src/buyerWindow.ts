/**
 * Buyers first (BUYER_WINDOW_SEC, off by default). When a liquidation hands the vault new stock, the keeper waits up
 * to `windowSec` before pushing any of it into the pool, so buyers can take it through the Uniswap v4 hook at its ask
 * first. The window closes as soon as any sale lands (a hook fill sets the vault's `lastUnwindAt`, like a push), or when
 * it runs out: buyers get first pick, never a veto.
 *
 * Fed every tick with the vault's state at the block the keeper read; times are block timestamps.
 */
export class BuyerWindow {
  private since: bigint | null = null; // when the current stock arrived
  private last = 0n; // inventory at the previous tick

  constructor(private readonly windowSec: bigint) {}

  observe(inventory: bigint, now: bigint): void {
    if (inventory === 0n) this.since = null;
    else if (inventory > this.last) this.since = now; // new stock: a liquidation (or a keeper restart)
    this.last = inventory;
  }

  /** True while an unwind push has to wait: new stock, nothing sold since, inside the window. */
  holds(lastUnwindAt: bigint, now: bigint): boolean {
    if (this.windowSec === 0n || this.since === null) return false;
    if (lastUnwindAt >= this.since) return false;
    return now < this.since + this.windowSec;
  }

  /** Seconds left, for logs. */
  remaining(now: bigint): bigint {
    return this.since === null ? 0n : this.since + this.windowSec - now;
  }
}
