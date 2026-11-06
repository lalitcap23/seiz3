import { describe, expect, it } from "vitest";

import { toCoreState } from "../src/hyperliquid.js";
import { cloidHex, decToBig, wireToDec } from "../src/units.js";

describe("decToBig", () => {
  it("scales exactly", () => {
    expect(decToBig("212.29", 3)).toBe(212_290n);
    expect(decToBig("-1.162", 3)).toBe(-1162n);
    expect(decToBig("120", 6)).toBe(120_000_000n);
    expect(decToBig("0.993576", 8)).toBe(99_357_600n);
  });
  it("rounds half away from zero past the decimals", () => {
    expect(decToBig("212.2915", 3)).toBe(212_292n);
    expect(decToBig("212.2914", 3)).toBe(212_291n);
    expect(decToBig("-0.0005", 3)).toBe(-1n);
  });
  it("rejects what isn't a decimal", () => {
    expect(() => decToBig("1e5", 3)).toThrow();
    expect(() => decToBig("", 3)).toThrow();
  });
});

describe("wire and cloid", () => {
  it("formats CoreWriter wire values the way the API takes them", () => {
    expect(wireToDec(20_988_000_000n)).toBe("209.88");
    expect(wireToDec(100_000_000n)).toBe("1");
    expect(wireToDec(50_000_000n)).toBe("0.5");
  });
  it("pads the cloid to 16 bytes", () => {
    expect(cloidHex(42n)).toBe(`0x${"0".repeat(30)}2a`);
    expect(cloidHex((1n << 128n) - 1n)).toBe(`0x${"f".repeat(32)}`);
  });
});

describe("toCoreState", () => {
  const state = {
    time: 1_793_983_439_979,
    marginSummary: { accountValue: "118.52", totalNtlPos: "212.29", totalMarginUsed: "70.763333" },
    assetPositions: [
      { position: { coin: "xyz:BTC", szi: "1", entryPx: "1", leverage: { value: 5 } } },
      { position: { coin: "xyz:NVDA", szi: "-1.0", entryPx: "212.27", leverage: { value: 3 } } },
    ],
  };

  it("maps a short into the precompiles' units", () => {
    const s = toCoreState(state, { oraclePx: "212.29", markPx: "212.3" }, "5.5", "xyz:NVDA", 3, true);
    expect(s).toEqual({
      observedAt: 1_793_983_439n,
      szi: -1000n,
      entryNtl: 1000n * 212_270n, // USD, 6 decimals: $212.27
      accountValue: 118_520_000n,
      marginUsed: 70_763_333n,
      ntlPos: 212_290_000n,
      spotUsdcWei: 550_000_000n,
      oraclePx: 212_290n,
      markPx: 212_300n,
      leverage: 3,
      exists: true,
    });
    expect(s.entryNtl).toBe(212_270_000n);
  });

  it("reads a flat account", () => {
    const flat = { ...state, assetPositions: [] };
    const s = toCoreState(flat, { oraclePx: "212.29", markPx: "212.29" }, "0", "xyz:NVDA", 3, false);
    expect(s.szi).toBe(0n);
    expect(s.entryNtl).toBe(0n);
    expect(s.leverage).toBe(0);
    expect(s.exists).toBe(false);
  });
});
