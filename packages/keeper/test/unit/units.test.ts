import { describe, expect, it } from "vitest";

import {
  formatDecimal,
  formatNvdax,
  formatUsdc,
  parseDecimal,
  parseNvdax,
  parseUsdc,
} from "../../src/riskCalc.js";

describe("units: parseDecimal", () => {
  it("parses whole and fractional values", () => {
    expect(parseDecimal("100", 6)).toBe(100_000_000n);
    expect(parseDecimal("12.5", 6)).toBe(12_500_000n);
    expect(parseDecimal("0.000001", 6)).toBe(1n);
    expect(parseDecimal("-1.25", 2)).toBe(-125n);
  });

  it("trims whitespace", () => {
    expect(parseUsdc(" 1.5 ")).toBe(1_500_000n);
  });

  it("rejects too many decimals", () => {
    expect(() => parseUsdc("1.1234567")).toThrow(/too many decimals/);
  });

  it("rejects malformed input", () => {
    expect(() => parseUsdc("1e6")).toThrow(/invalid decimal/);
    expect(() => parseUsdc("")).toThrow(/invalid decimal/);
    expect(() => parseUsdc("1.")).toThrow(/invalid decimal/);
  });
});

describe("units: formatting", () => {
  it("formats without trailing zeros", () => {
    expect(formatUsdc(1_500_000n)).toBe("1.5");
    expect(formatUsdc(100_000_000n)).toBe("100");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(-2_250_000n)).toBe("-2.25");
  });

  it("round-trips USDC and NVDAx", () => {
    expect(parseUsdc(formatUsdc(123_456_789n))).toBe(123_456_789n);
    expect(parseNvdax(formatNvdax(10n ** 18n + 1n))).toBe(10n ** 18n + 1n);
  });

  it("formats a zero-decimal value", () => {
    expect(formatDecimal(42n, 0)).toBe("42");
    expect(parseDecimal("42", 0)).toBe(42n);
  });
});
