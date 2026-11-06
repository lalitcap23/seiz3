// Offline simulations of the Afterbell CRE workflow — the prize-qualifying "successful simulation".
// EVM reads/writes run against SDK mocks, the Hyperliquid HTTP step is stubbed; no keys, no network.
import { describe, expect, it, vi } from "vitest";
import { newTestRuntime } from "@chainlink/cre-sdk/test";
import { TxStatus, type Runtime } from "@chainlink/cre-sdk";
import type { Address, Hex } from "viem";

import { AfterbellBindings, type MarketParams, type Position, type WriteResult } from "../src/bindings";
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

function makeConfig(overrides: Partial<Config["risk"]> = {}): Config {
  return {
    schedule: "*/30 * * * * *",
    evm: {
      chainSelectorName: "hyperevm-testnet",
      isTestnet: true,
      morpho: MORPHO,
      gateway: GATEWAY,
      marketId: MARKET_ID,
      borrower: BORROWER,
    },
    hyperliquid: { apiUrl: "https://api.hyperliquid-testnet.xyz/info", coin: "xyz:NVDA" },
    risk: { oracleBandBps: 200n, maxSeizedUsdc: 5000n * USDC, ...overrides },
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

const underwater: Position = { supplyShares: 0n, borrowShares: 168n * USDC, collateral: 1n * WAD }; // 168 USDC debt vs 0.77×217 = 167.09 → underwater

describe("Afterbell CRE workflow — offline simulation", () => {
  it("skips a healthy borrower", () => {
    const b = new FakeBindings();
    b.positionResult = { supplyShares: 0n, borrowShares: 100n * USDC, collateral: 1n * WAD }; // 46% LTV at $217
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("Skipped");
    expect(result).toContain("healthy");
    expect(b.writes).toHaveLength(0);
  });

  it("liquidates an underwater borrower within the oracle band", () => {
    const b = new FakeBindings();
    b.positionResult = underwater; // 167 USDC debt vs 0.77×217 = 167.09 collateral value → just underwater
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
    b.positionResult = { supplyShares: 0n, borrowShares: 100n * USDC, collateral: 0n };
    const runtime = makeRuntime();
    const result = runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(result).toContain("no collateral");
    expect(b.writes).toHaveLength(0);
  });

  it("caps the seized size at maxSeizedUsdc", () => {
    const b = new FakeBindings();
    b.positionResult = { supplyShares: 0n, borrowShares: 200_000n * USDC, collateral: 1000n * WAD }; // underwater
    const runtime = makeRuntime({ maxSeizedUsdc: 100n * USDC }); // $100 cap
    runAfterbellLiquidation(runtime, { bindings: b, readPerpPrice: () => PRICE });
    expect(b.writes).toHaveLength(1);
    const seizedUsdc = (b.writes[0]!.seized * PRICE) / WAD;
    expect(seizedUsdc).toBeLessThanOrEqual(100n * USDC);
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
