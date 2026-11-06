import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";

const MAX_WATCHED = 500;

/**
 * Addresses the keeper should check every tick: everyone who connected on /try or took a faucet drip. Morpho can't
 * list a market's borrowers and the keeper's Borrow-event scan depends on a rate-limited public logs RPC, so this
 * file (deployments/watch.json, shared with the keeper) is the path that doesn't. Newest first, capped.
 */
export class Watchlist {
  private addresses: Address[];

  constructor(private readonly path: string) {
    this.addresses = Watchlist.read(path);
  }

  add(address: string): boolean {
    if (!isAddress(address)) return false;
    const a = getAddress(address);
    if (this.addresses[0] === a) return true;
    this.addresses = [a, ...this.addresses.filter((x) => x !== a)].slice(0, MAX_WATCHED);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.addresses, null, 2)}\n`);
    renameSync(tmp, this.path); // the keeper never reads half a file
    return true;
  }

  list(): readonly Address[] {
    return this.addresses;
  }

  get size(): number {
    return this.addresses.length;
  }

  private static read(path: string): Address[] {
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string" && isAddress(a)).map((a) => getAddress(a)) : [];
    } catch {
      return [];
    }
  }
}
