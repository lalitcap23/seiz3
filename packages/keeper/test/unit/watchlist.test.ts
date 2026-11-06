import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readWatchlist } from "../../src/watchlist.js";
import { BORROWER_A, BORROWER_B } from "./fixtures.js";

describe("watchlist", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));

  it("reads the API's addresses and skips anything that isn't one", () => {
    const path = join(dir, "watch.json");
    writeFileSync(path, JSON.stringify([BORROWER_A, "nope", 7, BORROWER_B]));
    expect(readWatchlist(path)).toEqual([BORROWER_A, BORROWER_B]);
  });

  it("treats a missing, broken or unset file as empty", () => {
    expect(readWatchlist(join(dir, "missing.json"))).toEqual([]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "[\"0x");
    expect(readWatchlist(broken)).toEqual([]);
    expect(readWatchlist(null)).toEqual([]);
  });
});
