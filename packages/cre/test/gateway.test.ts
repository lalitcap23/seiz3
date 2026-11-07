// The Base Sepolia half of the workflow: the DON's own snapshot of the hedge account, signed into HyperCoreGateway.
// Same SDK test runtime as workflow.test.ts: node mode, consensus, HTTP and both EVM writes go through the SDK.
import { describe, expect } from "vitest";
import { getNetwork, type Runtime } from "@chainlink/cre-sdk";
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from "@chainlink/cre-sdk/test";
import { bytesToHex, decodeAbiParameters, type Hex } from "viem";

import { encodeSnapshot, parseSigned, toHedgeAccountRead } from "../src/gateway";
import { RISK_PARAMS_ABI } from "../src/riskParams";
import { onCronTrigger, type Config } from "../src/workflow";

const BASE_SEPOLIA = "ethereum-testnet-sepolia-base-1";
const RISK_PARAMS = "0x00000000000000000000000000000000000000aa" as const;
const GATEWAY = "0x00000000000000000000000000000000000000cc" as const;
const HEDGE = "0x00000000000000000000000000000000000000dd" as const;
const NOW_MS = Date.UTC(2026, 10, 6, 15, 0); // Fri 10:00 New York: open
const STATE_TIME_MS = NOW_MS - 1_500;

const SNAPSHOT_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "observedAt", type: "uint64" },
      { name: "szi", type: "int64" },
      { name: "entryNtl", type: "uint64" },
      { name: "accountValue", type: "int64" },
      { name: "marginUsed", type: "uint64" },
      { name: "ntlPos", type: "uint64" },
      { name: "spotUsdcWei", type: "uint64" },
      { name: "oraclePx", type: "uint64" },
      { name: "markPx", type: "uint64" },
      { name: "leverage", type: "uint32" },
      { name: "exists", type: "bool" },
      { name: "executedNonce", type: "uint64" },
    ],
  },
] as const;

const config: Config = {
  schedule: "0 */1 * * * *",
  evm: { chainSelectorName: BASE_SEPOLIA, isTestnet: true, riskParams: RISK_PARAMS, gasLimit: "300000", readBlock: "latest" },
  marketStatus: "marketHours",
  marketHours: { open: "09:30", close: "16:00", earlyClose: "13:00", holidays: [], earlyCloses: [] },
  hyperliquid: { apiUrl: "https://api.hyperliquid-testnet.xyz/info", dex: "xyz", coin: "xyz:NVDA" },
  bookShareBps: 10_000,
  gateway: { address: GATEWAY, hedgeAccount: HEDGE, szDecimals: 3, gasLimit: "400000" },
};

const CLEARINGHOUSE = {
  time: STATE_TIME_MS,
  marginSummary: { accountValue: "118.52", totalNtlPos: "212.29", totalMarginUsed: "70.763333" },
  assetPositions: [{ position: { coin: "xyz:NVDA", szi: "-1.0", entryPx: "212.27", leverage: { value: 3 } } }],
};
const SPOT = { balances: [{ coin: "USDC", total: "5.5" }] };
const CTXS = [
  { universe: [{ name: "xyz:AAPL" }, { name: "xyz:NVDA" }] },
  [
    { oraclePx: "270.1", markPx: "270.2" },
    { oraclePx: "212.29", markPx: "212.3" },
  ],
];

interface Seen {
  bodies: { type: string; user?: string }[];
  risk?: Hex;
  gateway?: Hex;
  gatewayGas?: bigint;
}

function arrange(over: Partial<Config> = {}, gatewayStatus = "TX_STATUS_SUCCESS"): { runtime: Runtime<Config>; seen: Seen } {
  const seen: Seen = { bodies: [] };
  const cfg = { ...config, ...over };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    const body = JSON.parse(Buffer.from(req.body).toString("utf8")) as { type: string; user?: string };
    seen.bodies.push(body);
    const reply =
      body.type === "l2Book"
        ? { coin: "xyz:NVDA", time: STATE_TIME_MS, levels: [[{ px: "212.01", sz: "1.049" }], [{ px: "239.32", sz: "1" }]] }
        : body.type === "clearinghouseState"
          ? CLEARINGHOUSE
          : body.type === "spotClearinghouseState"
            ? SPOT
            : CTXS;
    return { statusCode: 200, body: Buffer.from(JSON.stringify(reply)).toString("base64") };
  };

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: BASE_SEPOLIA, isTestnet: true })!;
  const evm = EvmMock.testInstance(network.chainSelector.selector);
  const risk = addContractMock(evm, { address: RISK_PARAMS, abi: RISK_PARAMS_ABI });
  risk.params = () => ({
    maxLiquidation: 50_000_000_000n,
    maxUnhedged: 500n,
    leverage: 3,
    marginBufferBps: 2000,
    minDiscountBps: 300,
    oracleBandBps: 150,
    hedgeCapBps: 100,
    maxSlippageBps: 150,
    maxTries: 3,
    orderDelaySec: 2,
    cooldownOpenSec: 10,
    cooldownClosedSec: 30,
    withdrawReserve: 10_000_000n,
    maxImpactBps: 120,
    transitBlocks: 1,
  });
  risk.writeReport = ({ report }) => {
    seen.risk = bytesToHex(report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    return { txStatus: "TX_STATUS_SUCCESS" };
  };
  const gateway = addContractMock(evm, { address: GATEWAY, abi: [] });
  gateway.writeReport = ({ report, gasConfig }) => {
    seen.gateway = bytesToHex(report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    seen.gatewayGas = gasConfig.gasLimit;
    return { txStatus: gatewayStatus as "TX_STATUS_SUCCESS" };
  };

  const runtime = newTestRuntime(new Map(), { timeProvider: () => NOW_MS }) as unknown as Runtime<Config>;
  (runtime as { config: Config }).config = cfg;
  return { runtime, seen };
}

describe("HyperCoreGateway attestation (Base Sepolia)", () => {
  test("Base Sepolia is in the CRE chain registry", () => {
    expect(getNetwork({ chainFamily: "evm", chainSelectorName: BASE_SEPOLIA, isTestnet: true })).toBeTruthy();
  });

  test("writes RiskParams and the DON's snapshot of the hedge account, in the gateway's units", () => {
    const { runtime, seen } = arrange();
    const summary = onCronTrigger(runtime);

    expect(seen.risk).toBeDefined();
    const [s] = decodeAbiParameters(SNAPSHOT_TUPLE, seen.gateway!);
    expect(s).toEqual({
      observedAt: BigInt(Math.floor(STATE_TIME_MS / 1000)),
      szi: -1000n,
      entryNtl: 212_270_000n,
      accountValue: 118_520_000n,
      marginUsed: 70_763_333n,
      ntlPos: 212_290_000n,
      spotUsdcWei: 550_000_000n,
      oraclePx: 212_290n,
      markPx: 212_300n,
      leverage: 3,
      exists: true,
      executedNonce: 0n, // the DON never acknowledges the relayer's orders
    });
    expect(seen.gatewayGas).toBe(400_000n);
    expect(summary).toContain("hedge account szi -1000 attested to the gateway");
  });

  test("reads the hedge account, not the vault", () => {
    const { runtime, seen } = arrange();
    onCronTrigger(runtime);
    const users = seen.bodies.filter((b) => b.user !== undefined).map((b) => b.user);
    expect(users).toEqual([HEDGE, HEDGE]);
  });

  test("without a gateway block nothing else is read or written (the market feed alone)", () => {
    const { runtime, seen } = arrange({ gateway: undefined });
    onCronTrigger(runtime);
    expect(seen.gateway).toBeUndefined();
    expect(seen.bodies.map((b) => b.type)).toEqual(["l2Book", "metaAndAssetCtxs"]);
  });

  test("a failed gateway write fails the run", () => {
    const { runtime } = arrange({}, "TX_STATUS_REVERTED");
    expect(() => onCronTrigger(runtime)).toThrow(/HyperCoreGateway report failed/);
  });
});

describe("pieces", () => {
  test("parseSigned keeps the sign and cuts extra places", () => {
    expect(parseSigned("-1.162", 3)).toBe(-1162n);
    expect(parseSigned("212.2999", 3)).toBe(212_299n);
    expect(parseSigned("0", 8)).toBe(0n);
    expect(() => parseSigned("1e3", 3)).toThrow();
  });

  test("a flat, empty account reads as not existing", () => {
    const r = toHedgeAccountRead(
      { time: 0, marginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalMarginUsed: "0.0" }, assetPositions: [] },
      { balances: [] },
      CTXS as never,
      "xyz:NVDA",
      3,
    );
    expect(r.exists).toBe(0);
    expect(r.szi).toBe(0n);
  });

  test("snapshot encoding is the layout HyperCoreGateway decodes (12 static words)", () => {
    const hex = encodeSnapshot(toHedgeAccountRead(CLEARINGHOUSE, SPOT, CTXS as never, "xyz:NVDA", 3));
    expect((hex.length - 2) / 64).toBe(12);
  });
});
