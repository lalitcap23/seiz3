import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buyNeeded, checkBuyLiquidity } from "../../src/liquidityGate.js";
import { makeState } from "./fixtures.js";

const NVDAX = 10n ** 18n;
const unwind = { kind: "unwindStep" } as const;
const sync = { kind: "syncHedge" } as const;

/** Hyperliquid info API with one oracle price and the given asks. */
function fakeInfo(oracle: string, asks: [string, string][]) {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string };
    const json =
      body.type === "metaAndAssetCtxs"
        ? [{ universe: [{ name: "xyz:NVDA" }] }, [{ oraclePx: oracle }]]
        : { levels: [[], asks.map(([px, sz]) => ({ px, sz }))] };
    return new Response(JSON.stringify(json));
  }) as unknown as typeof fetch;
}

describe("buy-back liquidity gate", () => {
  it("an unwind buys back the over-short plus the chunk, the chunk counted at most chunkUnits", () => {
    // 0.588 NVDAx held, short 0.850: 262 over-short; chunk min(588, maxUnhedged 500, estimate 100)
    const state = makeState({ inventory: 588n * NVDAX / 1000n, confirmedShort: -850n, risk: { maxUnhedged: 500n } });
    expect(buyNeeded(unwind, state, 3, 100n)).toBe(262n + 100n);
    // matched hedge: just the chunk
    expect(buyNeeded(unwind, makeState({ inventory: 588n * NVDAX / 1000n, confirmedShort: -588n }), 3, 100n)).toBe(100n);
    // a sync only buys when a buy is pending
    expect(buyNeeded(sync, makeState({ pendingHedge: { delta: 66n } }), 3, 100n)).toBe(66n);
    expect(buyNeeded(sync, makeState({ pendingHedge: { delta: -82n } }), 3, 100n)).toBe(0n);
    expect(buyNeeded({ kind: "liquidate" } as never, state, 3, 100n)).toBe(0n);
  });

  it("passes when asks within oracle + hedgeCap cover the buy, counting every level under the cap", async () => {
    const gate = { hlInfoUrl: "http://hl", coin: "xyz:NVDA", requestFile: null };
    const info = fakeInfo("200", [["201", "0.2"], ["201.9", "0.2"], ["203", "5"]]);
    expect(await checkBuyLiquidity(gate, 400n, 3, 100n, info)).toEqual({ ok: true });
    expect((await checkBuyLiquidity(gate, 401n, 3, 100n, info)).ok).toBe(false); // the 203 ask is past the 1% cap
  });

  it("without enough, waits and asks the market maker for the size", async () => {
    const requestFile = join(mkdtempSync(join(tmpdir(), "gate-")), "ASK_REQUEST.json");
    const gate = { hlInfoUrl: "http://hl", coin: "xyz:NVDA", requestFile };
    const res = await checkBuyLiquidity(gate, 362n, 3, 100n, fakeInfo("213.6", [["226.28", "0.067"]]));
    expect(res).toEqual({ ok: false, reason: "waiting-for-ask", needNvda: 0.362 });
    const req = JSON.parse(readFileSync(requestFile, "utf8")) as { sizeNvda: number; until: number };
    expect(req.sizeNvda).toBe(0.362);
    expect(req.until).toBeGreaterThan(Date.now());

    // the market maker posts it: the keeper goes ahead, and keeps the request alive while its order lands
    expect(await checkBuyLiquidity(gate, 362n, 3, 100n, fakeInfo("213.6", [["214.4", "0.48"]]))).toEqual({ ok: true });
    const kept = JSON.parse(readFileSync(requestFile, "utf8")) as { until: number };
    expect(kept.until).toBeGreaterThan(Date.now());
  });

  it("is off without an info API, and for actions that buy nothing", async () => {
    const off = { hlInfoUrl: null, coin: "xyz:NVDA", requestFile: null };
    expect(await checkBuyLiquidity(off, 362n, 3, 100n)).toEqual({ ok: true });
    const on = { hlInfoUrl: "http://hl", coin: "xyz:NVDA", requestFile: null };
    expect(await checkBuyLiquidity(on, 0n, 3, 100n, fakeInfo("1", []))).toEqual({ ok: true });
  });
});
