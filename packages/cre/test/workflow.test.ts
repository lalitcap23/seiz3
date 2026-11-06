// Offline simulations of the Afterbell CRE workflow — the prize-qualifying "successful simulation".
// EVM reads/writes run against test doubles, the Hyperliquid HTTP step is stubbed; no keys, no
// network. The risk assertions use Morpho's real formulas (LLTV health + liquidation incentive
// factor), so a passing suite means the workflow would not waste a DON write on a revert.
import { describe, expect, it, vi } from "vitest";
import { newTestRuntime } from "@chainlink/cre-sdk/test";
import { hexToBase64, getNetwork, TxStatus, type Runtime } from "@chainlink/cre-sdk";
import { encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";

import { AfterbellBindings, type MarketParams, type MarketTotals, type Position, type WriteResult } from "../src/bindings";
import { liquidationIncentiveFactor, toBorrowAssetsUp } from "../src/risk";
import { runAfterbellLiquidation, type Config } from "../src/workflow";

const MARKET_ID = "0x6812cb8d824ef23d481b1bd4d829492495acc67304d16a6ae6942d3c0b3b21b2" as Hex; // testnet market C
const BORROWER = "0x7Ea067328338D368038Fc677A7Fb17C9770D3F54" as Address;
const MORPHO = "0x63c539784853717B1b879F7baC1cb16b8148B3CE" as Address;
const GATEWAY = "0x0000000000000000000000000000000000000C45" as Address;
const ORACLE = "0xCe0A8975F6C6122b7771B358526BE941db100B93" as Address;

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;
const PRICE = 217n * USDC; // $217.00
const LLTV = 77n * 10n ** 16n; // 0.77e18
const TOTALS: MarketTotals = { totalBorrowAssets: 10n ** 12n, totalBorrowShares: 10n ** 12n };

function makeConfig(overrides: Partial<Config["risk"]> = {}): Config {
  return {
    schedule: "0 */1 * * * *",
    evm: {
      chainSelectorName: "hyperliquid-testnet",
      isTestnet: true,
      morpho: MORPHO,
      gateway: GATEWAY,
      marketId: MARKET_ID,
      borrower: BORROWER,
    },
    hyperliquid: { apiUrl: "https://api.hyperliquid-testnet.xyz/info", coin: "xyz:NVDA" },
    risk: { oracleBandBps: 200n, maxSeizedUsdc: 5000n * USDC, szDecimals: 3, ...overrides },
  };
}

function makeRuntime(overrides: Partial<Config["risk"]> = {}) {
  const runtime = newTestRuntime() as Runtime<Config>;
  (runtime as { config: Config }).config = makeConfig(overrides);
  return runtime;
}

/** Binding test double: canned on-chain reads and a recorded write, no network. */
class FakeBindings extends AfterbellBindings {
  positionResult: Position = { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
  marketResult: MarketTotals = TOTALS;
  marketParamsResult: MarketParams = {
    loanToken: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
    collateralToken: "0xa1e0804D9C3dcD45495A11f1B71A6C1abD8D42CB",
    oracle: ORACLE,
    irm: "0xc21aA4331F5EF75625004bC4AcA14480247e1b4F",
    lltv: LLTV,
  };
  lendingPriceRawResult = PRICE * 10n ** 18n; // DemoOracle raw (USD × 1e24)
  writes: Array<{ marketId: Hex; borrower: Address; seized: bigint }> = [];
  writeStatus: TxStatus = TxStatus.SUCCESS;

  constructor() {
    super(undefined as never, MORPHO, GATEWAY);
  }

  override position(): Position {
    return this.positionResult;
  }
  override market(): MarketTotals {
    return this.marketResult;
  }
  override marketParams(): MarketParams {
    return this.marketParamsResult;
  }
  override lendingPriceRaw(): bigint {
    return this.lendingPriceRawResult;
  }
  override writeLiquidation(_r: Runtime<unknown>, marketId: Hex, borrower: Address, seized: bigint): WriteResult {
    this.writes.push({ marketId, borrower, seized });
    return { txStatus: this.writeStatus };
  }
}

function positionOf(borrowAssets: bigint, collateral: bigint): Position {
  return { supplyShares: 0n, borrowShares: borrowAssets, collateral };
}

// 1 NVDAx at $217 → max borrow 167.09 USDC at 77% LLTV.
const underwater = positionOf(168n * USDC, 1n * WAD);
const healthy = positionOf(167n * USDC, 1n * WAD);

describe("Afterbell CRE workflow — offline simulation", () => {
  it("skips a healthy borrower", () => {
    const b = new FakeBindings();
    b.positionResult = healthy; // 100.05% of max borrow
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("Skipped");
    expect(result).toContain("healthy");
    expect(b.writes).toHaveLength(0);
  });

  it("liquidates an underwater borrower within the oracle band", () => {
    const b = new FakeBindings();
    b.positionResult = underwater;
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("Executed");
    expect(b.writes).toHaveLength(1);
    expect(b.writes[0]!.marketId).toBe(MARKET_ID);
    expect(b.writes[0]!.borrower).toBe(BORROWER);
    expect(b.writes[0]!.seized).toBeGreaterThan(0n);
  });

  it("refuses when lending and Hyperliquid oracles disagree beyond the band", () => {
    const b = new FakeBindings();
    b.positionResult = underwater;
    b.lendingPriceRawResult = (PRICE * 103n / 100n) * 10n ** 18n; // +3% vs Core, band is 2%
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("Skipped");
    expect(result).toContain("oracle band");
    expect(b.writes).toHaveLength(0);
  });

  it("skips when the borrower has no collateral", () => {
    const b = new FakeBindings();
    b.positionResult = positionOf(100n * USDC, 0n);
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("no collateral");
    expect(b.writes).toHaveLength(0);
  });

  it("caps the seized size at maxSeizedUsdc", () => {
    const b = new FakeBindings();
    b.positionResult = positionOf(200_000n * USDC, 1000n * WAD); // underwater
    const runtime = makeRuntime({ maxSeizedUsdc: 100n * USDC }); // $100 cap
    runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(b.writes).toHaveLength(1);
    const seizedUsdc = (b.writes[0]!.seized * PRICE) / WAD;
    expect(seizedUsdc).toBeLessThanOrEqual(100n * USDC);
  });

  it("sizes with Morpho's liquidation incentive factor, not 1/LLTV", () => {
    const b = new FakeBindings();
    b.positionResult = underwater;
    const runtime = makeRuntime({ maxSeizedUsdc: 1_000_000n * USDC }); // non-binding
    runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(b.writes).toHaveLength(1);
    // debt × LIF / price ≈ 168 × 1.0741 / 217 ≈ 0.8316 NVDAx
    const expected = (168n * USDC * liquidationIncentiveFactor(LLTV)) / WAD; // USDC value
    const actualUsdc = (b.writes[0]!.seized * PRICE) / WAD;
    expect(actualUsdc).toBeLessThanOrEqual(expected);
    expect(actualUsdc).toBeGreaterThan(expected - 2n * USDC); // within $2
    // and materially below the naive debt/LLTV sizing (≈1.005 NVDAx)
    const naiveSeized = ((168n * USDC * WAD) / LLTV) * WAD / PRICE;
    expect(b.writes[0]!.seized).toBeLessThan(naiveSeized);
  });

  it("skips sizes below one HyperCore lot", () => {
    const b = new FakeBindings();
    b.positionResult = positionOf(200_000n, 10n ** 15n); // $0.20 debt vs $0.217 collateral
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("below one core lot");
    expect(b.writes).toHaveLength(0);
  });

  it("throws when the DON-signed write fails", () => {
    const b = new FakeBindings();
    b.positionResult = underwater;
    b.writeStatus = TxStatus.REVERTED;
    const runtime = makeRuntime();
    expect(() =>
      runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE }),
    ).toThrow(/liquidation tx failed/);
  });

  it("uses the Hyperliquid price step output (external data) in the decision", () => {
    const b = new FakeBindings();
    b.positionResult = underwater;
    const runtime = makeRuntime();
    const spy = vi.fn(() => PRICE);
    runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: spy });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("CRE bindings — report encoding", () => {
  it("sends the raw abi.encode payload, not onReport calldata", () => {
    let captured: { encodedPayload?: string; receiver?: string } = {};
    const client = {
      writeReport: (_rt: unknown, input: { receiver: string }) => {
        captured = { ...captured, receiver: input.receiver };
        return { result: () => ({ txStatus: TxStatus.SUCCESS }) };
      },
    };
    const runtime = {
      report: (input: { encodedPayload: string }) => {
        captured = { ...captured, encodedPayload: input.encodedPayload };
        return { result: () => ({}) };
      },
    };
    const bindings = new AfterbellBindings(client as never, MORPHO, GATEWAY);

    bindings.writeLiquidation(runtime as never, MARKET_ID, BORROWER, 123n);

    const expected = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [MARKET_ID, BORROWER, 123n],
    );
    expect(captured.receiver).toBe(GATEWAY);
    expect(captured.encodedPayload).toBe(hexToBase64(expected));
  });
});

describe("Morpho math mirrors", () => {
  it("computes LIF = min(1.15, 1/(1 − 0.3×(1 − LLTV)))", () => {
    expect(liquidationIncentiveFactor(LLTV)).toBe(1_074_113_856_068_743_286n);
    expect(liquidationIncentiveFactor(0n)).toBe(WAD);
    expect(liquidationIncentiveFactor(WAD / 2n)).toBe(1_150_000_000_000_000_000n);
  });

  it("converts borrow shares to assets with Morpho's virtual shares", () => {
    expect(toBorrowAssetsUp(168n * USDC, 10n ** 12n, 10n ** 12n)).toBe(167_999_833n);
  });
});

describe("CRE chain registry", () => {
  it("resolves HyperEVM testnet by name", () => {
    const network = getNetwork({
      chainFamily: "evm",
      chainSelectorName: "hyperliquid-testnet",
      isTestnet: true,
    });
    expect(network?.chainSelector.selector).toBe(4_286_062_357_653_186_312n);
  });
});
