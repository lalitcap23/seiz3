// Offline simulations of the Afterbell market feed. They run the real workflow through the CRE SDK's test runtime:
// secrets, node-mode consensus, the HTTP capability, the EVM read and the signed writeReport all go through the SDK,
// with only the far ends (Data Streams, Hyperliquid, HyperEVM) mocked. No keys, no network.
import { describe, expect } from "vitest";
import { getNetwork, type Runtime } from "@chainlink/cre-sdk";
import {
  addContractMock,
  EvmMock,
  HttpActionsMock,
  newTestRuntime,
  REPORT_METADATA_HEADER_LENGTH,
  test,
} from "@chainlink/cre-sdk/test";
import { bytesToHex, decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";

import { hedgeCapacityUsd6, hedgeFloorUsd6, parseDecimal } from "../src/book";
import { AGGREGATOR_V3_ABI, priceGapBps } from "../src/dataFeed";
import { authHeaders, decodeMarketStatus } from "../src/datastreams";
import { isMarketOpen, newYorkOffsetHours, newYorkTime } from "../src/marketHours";
import { encodeMarketReport, RISK_PARAMS_ABI } from "../src/riskParams";
import { configSchema, onCronTrigger, SECRET_API_KEY, SECRET_API_SECRET, type Config } from "../src/workflow";

const RISK_PARAMS = "0x00000000000000000000000000000000000000aa" as const;
const FEED_V8 = "0x0008aaaa00000000000000000000000000000000000000000000000000000001" as const;
const FEED_V11 = "0x000baaaa00000000000000000000000000000000000000000000000000000001" as const;
const NOW_MS = 1_800_000_060_000;
const DS_OBSERVED = 1_800_000_055;
const BOOK_TIME_MS = 1_800_000_058_500;
const API_KEY = "6a2b0c8e-0000-4000-8000-000000000001";
const API_SECRET = "s3cr3t";

// a test calendar: one holiday and one early close
const HOURS: NonNullable<Config["marketHours"]> = {
  open: "09:30",
  close: "16:00",
  earlyClose: "13:00",
  holidays: ["2026-11-26"],
  earlyCloses: ["2026-11-27"],
};
const FEED_PROXY = "0x00000000000000000000000000000000000000bb" as const;
const FEED_DECIMALS = 8;
// Fri 2026-11-06 10:00 New York (EST): the regular session
const OPEN_MS = Date.UTC(2026, 10, 6, 15, 0);

const config: Config = {
  schedule: "0 */1 * * * *",
  evm: { chainSelectorName: "hyperliquid-testnet", isTestnet: true, riskParams: RISK_PARAMS, gasLimit: "300000", readBlock: "finalized" },
  marketStatus: "dataStreams",
  marketHours: HOURS,
  dataStreams: { apiUrl: "https://api.testnet-dataengine.chain.link", feedId: FEED_V8 },
  hyperliquid: { apiUrl: "https://api.hyperliquid-testnet.xyz/info", dex: "xyz", coin: "xyz:NVDA" },
  bookShareBps: 10_000,
};

// the testnet xyz:NVDA book this was written against: oracle $212.87, hedge band 1% → floor $210.75
const BIDS = [
  { px: "214.7", sz: "0.992" },
  { px: "212.87", sz: "0.048" },
  { px: "210.76", sz: "0.705" },
  { px: "200.0", sz: "0.07" },
];
const ORACLE = "212.87";
// (0.992 + 0.048 + 0.705) NVDA × $212.87
const CAPACITY_1PCT = 371_458_150n;

function v8Blob(feedId: Hex, observedAt: number, status: number): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint192" },
      { type: "uint192" },
      { type: "uint32" },
      { type: "uint64" },
      { type: "int192" },
      { type: "uint32" },
    ],
    [feedId, observedAt - 1, observedAt, 0n, 0n, observedAt + 86_400, BigInt(observedAt) * 10n ** 9n, 212_87n * 10n ** 16n, status],
  );
}

function v11Blob(feedId: Hex, observedAt: number, status: number): Hex {
  const px = 212_87n * 10n ** 16n;
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint192" },
      { type: "uint192" },
      { type: "uint32" },
      { type: "int192" },
      { type: "uint64" },
      { type: "int192" },
      { type: "int192" },
      { type: "int192" },
      { type: "int192" },
      { type: "int192" },
      { type: "uint32" },
    ],
    [feedId, observedAt - 1, observedAt, 0n, 0n, observedAt + 86_400, px, BigInt(observedAt) * 10n ** 9n, px, 10n ** 18n, px, 10n ** 18n, px, status],
  );
}

function fullReport(blob: Hex): Hex {
  const z = `0x${"00".repeat(32)}` as Hex;
  return encodeAbiParameters(
    [{ type: "bytes32[3]" }, { type: "bytes" }, { type: "bytes32[]" }, { type: "bytes32[]" }, { type: "bytes32" }],
    [[z, z, z], blob, [z], [z], z],
  );
}

interface Scenario {
  dsStatus?: number;
  dsFullReport?: Hex;
  dsHttpStatus?: number;
  bids?: { px: string; sz: string }[];
  hedgeCapBps?: number;
  bookTimeMs?: number;
  writeStatus?: "TX_STATUS_SUCCESS" | "TX_STATUS_REVERTED";
  receiverStatus?: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS" | "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED";
  nowMs?: number;
  feed?: { price: string; updatedAt: number }; // Chainlink Data Feed answer ("189.69") and its update time
  cfg?: Partial<Config>;
}

interface Seen {
  dsHeaders?: Record<string, string>;
  dsUrl?: string;
  hlBodies: unknown[];
  written?: { open: boolean; hedgeCapacity: bigint; observedAt: bigint };
  gasLimit?: bigint;
  feedCalls: number;
}

/** Wire the mocks for one run and return what the workflow sent them. */
function arrange(s: Scenario = {}): { runtime: Runtime<Config>; seen: Seen } {
  const seen: Seen = { hlBodies: [], feedCalls: 0 };
  const cfg = { ...config, ...s.cfg };

  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    if (req.url.startsWith(cfg.dataStreams!.apiUrl)) {
      seen.dsUrl = req.url;
      seen.dsHeaders = req.headers;
      const body = JSON.stringify({
        report: { fullReport: s.dsFullReport ?? fullReport(v8Blob(FEED_V8, DS_OBSERVED, s.dsStatus ?? 2)) },
      });
      return { statusCode: s.dsHttpStatus ?? 200, body: Buffer.from(body).toString("base64") };
    }
    const sent = JSON.parse(Buffer.from(req.body).toString("utf8")) as { type: string };
    seen.hlBodies.push(sent);
    const reply =
      sent.type === "l2Book"
        ? { coin: "xyz:NVDA", time: s.bookTimeMs ?? BOOK_TIME_MS, levels: [s.bids ?? BIDS, [{ px: "215", sz: "1" }]] }
        : [{ universe: [{ name: "xyz:AAPL" }, { name: "xyz:NVDA" }] }, [{ oraclePx: "270.1" }, { oraclePx: ORACLE }]];
    return { statusCode: 200, body: Buffer.from(JSON.stringify(reply)).toString("base64") };
  };

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: "hyperliquid-testnet", isTestnet: true })!;
  const evm = EvmMock.testInstance(network.chainSelector.selector);
  const risk = addContractMock(evm, { address: RISK_PARAMS, abi: RISK_PARAMS_ABI });
  risk.params = () => ({
    maxLiquidation: 50_000_000_000n,
    maxUnhedged: 2000n,
    leverage: 3,
    marginBufferBps: 2000,
    minDiscountBps: 300,
    oracleBandBps: 150,
    hedgeCapBps: s.hedgeCapBps ?? 100,
    maxSlippageBps: 100,
    maxTries: 3,
    orderDelaySec: 5,
    cooldownOpenSec: 10,
    cooldownClosedSec: 300,
    withdrawReserve: 500_000_000n,
    maxImpactBps: 50,
    transitBlocks: 1,
  });
  risk.writeReport = ({ report, gasConfig }) => {
    const payload = bytesToHex(report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    const [open, hedgeCapacity, observedAt] = decodeAbiParameters(
      [{ type: "bool" }, { type: "uint256" }, { type: "uint64" }],
      payload,
    );
    seen.written = { open, hedgeCapacity, observedAt };
    seen.gasLimit = gasConfig.gasLimit;
    return {
      txStatus: s.writeStatus ?? "TX_STATUS_SUCCESS",
      ...(s.receiverStatus ? { receiverContractExecutionStatus: s.receiverStatus } : {}),
    };
  };

  if (cfg.dataFeed) {
    const eth = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.dataFeed.chainSelectorName, isTestnet: cfg.dataFeed.isTestnet })!;
    const feed = addContractMock(EvmMock.testInstance(eth.chainSelector.selector), { address: FEED_PROXY, abi: AGGREGATOR_V3_ABI });
    const f = s.feed ?? { price: "212.87", updatedAt: Math.floor((s.nowMs ?? NOW_MS) / 1000) - 60 };
    feed.decimals = () => FEED_DECIMALS;
    feed.latestRoundData = () => {
      seen.feedCalls++;
      return [1n, parseDecimal(f.price, FEED_DECIMALS), BigInt(f.updatedAt), BigInt(f.updatedAt), 1n];
    };
  }

  const secrets = new Map([["default", new Map([[SECRET_API_KEY, API_KEY], [SECRET_API_SECRET, API_SECRET]])]]);
  const runtime = newTestRuntime(secrets, { timeProvider: () => s.nowMs ?? NOW_MS }) as unknown as Runtime<Config>;
  (runtime as { config: Config }).config = cfg;
  return { runtime, seen };
}

describe("market feed workflow (SDK test runtime)", () => {
  test("market open: writes open + the book's capacity inside the hedge band to RiskParams", () => {
    const { runtime, seen } = arrange();
    const summary = onCronTrigger(runtime);

    expect(seen.written).toEqual({ open: true, hedgeCapacity: CAPACITY_1PCT, observedAt: BigInt(DS_OBSERVED) });
    expect(seen.gasLimit).toBe(300_000n);
    expect(summary).toContain("market open (status 2)");
    expect(summary).toContain("within 100 bps");
  });

  test("market closed: status 1 reports closed", () => {
    const { runtime, seen } = arrange({ dsStatus: 1 });
    onCronTrigger(runtime);
    expect(seen.written?.open).toBe(false);
  });

  test("unknown status 0 reports closed: the vault never prices as open on a guess", () => {
    const { runtime, seen } = arrange({ dsStatus: 0 });
    onCronTrigger(runtime);
    expect(seen.written?.open).toBe(false);
  });

  test("v11 stream: regular hours is open, overnight is not", () => {
    const regular = arrange({ cfg: { dataStreams: { ...config.dataStreams!, feedId: FEED_V11 } }, dsFullReport: fullReport(v11Blob(FEED_V11, DS_OBSERVED, 2)) });
    onCronTrigger(regular.runtime);
    expect(regular.seen.written?.open).toBe(true);

    const overnight = arrange({ cfg: { dataStreams: { ...config.dataStreams!, feedId: FEED_V11 } }, dsFullReport: fullReport(v11Blob(FEED_V11, DS_OBSERVED, 4)) });
    onCronTrigger(overnight.runtime);
    expect(overnight.seen.written?.open).toBe(false);
  });

  test("v11 stream: the equity market's top of book is reported alongside HyperCore's depth (not written on-chain)", () => {
    const { runtime, seen } = arrange({
      cfg: { dataStreams: { ...config.dataStreams!, feedId: FEED_V11 } },
      dsFullReport: fullReport(v11Blob(FEED_V11, DS_OBSERVED, 2)),
    });
    const summary = onCronTrigger(runtime);
    expect(summary).toContain("equity book $212.87 × 1 / $212.87 × 1");
    expect(seen.written).toEqual({ open: true, hedgeCapacity: CAPACITY_1PCT, observedAt: BigInt(DS_OBSERVED) });
  });

  test("v8 stream: no top of book, nothing extra in the summary", () => {
    const { runtime } = arrange();
    expect(onCronTrigger(runtime)).not.toContain("equity book");
  });

  test("the hedge band comes from RiskParams on-chain: a wider band counts deeper bids", () => {
    const { runtime, seen } = arrange({ hedgeCapBps: 700 }); // floor $197.97: the $200 bid counts too
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(CAPACITY_1PCT + 14_900_900n); // + 0.07 × $212.87
  });

  test("bookShareBps takes only part of the visible depth", () => {
    const { runtime, seen } = arrange({ cfg: { bookShareBps: 5000 } });
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(CAPACITY_1PCT / 2n);
  });

  test("an empty band reports zero capacity: the vault stops liquidating", () => {
    const { runtime, seen } = arrange({ bids: [{ px: "150", sz: "100" }] });
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(0n);
  });

  test("observedAt is the older of the two observations", () => {
    const { runtime, seen } = arrange({ bookTimeMs: (DS_OBSERVED - 30) * 1000 });
    onCronTrigger(runtime);
    expect(seen.written?.observedAt).toBe(BigInt(DS_OBSERVED - 30));
  });

  test("Data Streams request: latest report for the feed, HMAC-signed with the secret", () => {
    const { runtime, seen } = arrange();
    onCronTrigger(runtime);

    const path = `/api/v1/reports/latest?feedID=${FEED_V8}`;
    expect(seen.dsUrl).toBe(`${config.dataStreams!.apiUrl}${path}`);
    expect(seen.dsHeaders).toEqual({
      Authorization: API_KEY,
      "X-Authorization-Timestamp": String(NOW_MS), // the node's clock, not the DON's
      // python3: hmac.new(b"s3cr3t", f"GET {path} {sha256(b'').hexdigest()} {key} {ts}".encode(), sha256)
      "X-Authorization-Signature-SHA256": "782fc95fa258cc74646b0303a16b00181cc5964e24ac5c9e945c42fa7a38c458",
      "User-Agent": "afterbell-cre/1.0",
    });
  });

  test("Hyperliquid requests are JSON bodies (base64 on the wire), not raw strings", () => {
    const { runtime, seen } = arrange();
    onCronTrigger(runtime);
    expect(seen.hlBodies).toEqual([{ type: "l2Book", coin: "xyz:NVDA" }, { type: "metaAndAssetCtxs", dex: "xyz" }]);
  });

  test("a Data Streams error writes nothing", () => {
    const { runtime, seen } = arrange({ dsHttpStatus: 401 });
    expect(() => onCronTrigger(runtime)).toThrow(/data streams: HTTP 401/);
    expect(seen.written).toBeUndefined();
  });

  test("a report for another feed is refused", () => {
    const { runtime, seen } = arrange({ dsFullReport: fullReport(v8Blob(FEED_V8.replace(/01$/, "02") as Hex, DS_OBSERVED, 2)) });
    expect(() => onCronTrigger(runtime)).toThrow(/asked for/);
    expect(seen.written).toBeUndefined();
  });

  test("a reverted write fails the run", () => {
    const { runtime } = arrange({ writeStatus: "TX_STATUS_REVERTED" });
    expect(() => onCronTrigger(runtime)).toThrow(/RiskParams report failed/);
  });

  test("RiskParams reverting inside a mined forwarder tx fails the run", () => {
    const { runtime } = arrange({ receiverStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED" });
    expect(() => onCronTrigger(runtime)).toThrow(/RiskParams rejected the report/);
  });
});

describe("market status from market hours (no Data Streams)", () => {
  const hours = (nowMs: number, extra: Scenario = {}) =>
    arrange({ nowMs, bookTimeMs: nowMs - 1_500, cfg: { marketStatus: "marketHours" }, ...extra });

  test("regular session: open, and Data Streams is never called", () => {
    const { runtime, seen } = hours(OPEN_MS);
    const summary = onCronTrigger(runtime);
    expect(seen.dsUrl).toBeUndefined();
    expect(seen.written).toEqual({ open: true, hedgeCapacity: CAPACITY_1PCT, observedAt: BigInt(Math.floor((OPEN_MS - 1_500) / 1000)) });
    expect(summary).toContain("market open (market hours)");
  });

  test("before the open, on a weekend and on a holiday: closed", () => {
    for (const t of [Date.UTC(2026, 10, 6, 14, 29), Date.UTC(2026, 10, 7, 15), Date.UTC(2026, 10, 26, 15)]) {
      const { runtime, seen } = hours(t);
      onCronTrigger(runtime);
      expect(seen.written?.open).toBe(false);
    }
  });

  test("observedAt is the DON clock when the book is newer", () => {
    const { runtime, seen } = arrange({ nowMs: OPEN_MS, bookTimeMs: OPEN_MS + 5_000, cfg: { marketStatus: "marketHours" } });
    onCronTrigger(runtime);
    expect(seen.written?.observedAt).toBe(BigInt(OPEN_MS / 1000));
  });

  test("the config must carry the block its marketStatus names", () => {
    const { marketHours: _, ...noHours } = config;
    expect(configSchema.safeParse({ ...noHours, marketStatus: "marketHours" }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, marketStatus: "marketHours" }).success).toBe(true);
  });
});

describe("Chainlink Data Feed price check", () => {
  const nowSec = Math.floor(OPEN_MS / 1000);
  const withFeed = (enforce: boolean, feed: Scenario["feed"]) =>
    arrange({
      nowMs: OPEN_MS,
      bookTimeMs: OPEN_MS - 1_500,
      feed,
      cfg: {
        marketStatus: "marketHours",
        dataFeed: { chainSelectorName: "ethereum-mainnet", isTestnet: false, proxy: FEED_PROXY, enforce, maxAgeSec: 3600 },
      },
    });

  test("within the vault's oracle band: the capacity stands", () => {
    const { runtime, seen } = withFeed(true, { price: "211.00", updatedAt: nowSec - 60 }); // 88 bps under HyperCore
    const summary = onCronTrigger(runtime);
    expect(seen.feedCalls).toBe(1);
    expect(seen.written?.hedgeCapacity).toBe(CAPACITY_1PCT);
    expect(summary).toContain("Chainlink gap 88 bps");
  });

  test("outside the band and enforced: zero capacity, so the vault stops buying", () => {
    const { runtime, seen } = withFeed(true, { price: "189.69", updatedAt: nowSec - 60 });
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(0n);
    expect(seen.written?.open).toBe(true); // the status is unaffected
  });

  test("not enforced (testnet's frozen oracle): observed only", () => {
    const { runtime, seen } = withFeed(false, { price: "189.69", updatedAt: nowSec - 60 });
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(CAPACITY_1PCT);
  });

  test("a paused feed (weekend) isn't compared", () => {
    const { runtime, seen } = withFeed(true, { price: "189.69", updatedAt: nowSec - 3601 });
    onCronTrigger(runtime);
    expect(seen.written?.hedgeCapacity).toBe(CAPACITY_1PCT);
  });
});

describe("pieces", () => {
  test("New York's offset follows US daylight saving", () => {
    expect(newYorkOffsetHours(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5); // 01:59 EST
    expect(newYorkOffsetHours(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4); // 03:00 EDT
    expect(newYorkOffsetHours(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4); // 01:59 EDT
    expect(newYorkOffsetHours(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5); // 01:00 EST
    expect(newYorkTime(Date.UTC(2026, 10, 7, 3, 0))).toEqual({ day: "2026-11-06", weekday: 5, minute: 22 * 60 });
  });

  test("session edges: open is inclusive, close exclusive, early close at 13:00", () => {
    expect(isMarketOpen(Date.UTC(2026, 10, 6, 14, 30), HOURS)).toBe(true); // 09:30 EST
    expect(isMarketOpen(Date.UTC(2026, 10, 6, 20, 59), HOURS)).toBe(true); // 15:59
    expect(isMarketOpen(Date.UTC(2026, 10, 6, 21, 0), HOURS)).toBe(false); // 16:00
    expect(isMarketOpen(Date.UTC(2026, 6, 6, 13, 30), HOURS)).toBe(true); // 09:30 EDT in July
    expect(isMarketOpen(Date.UTC(2026, 10, 27, 17, 59), HOURS)).toBe(true); // 12:59 on the early-close day
    expect(isMarketOpen(Date.UTC(2026, 10, 27, 18, 0), HOURS)).toBe(false); // 13:00
    expect(() => isMarketOpen(OPEN_MS, { ...HOURS, open: "9:30" })).toThrow(/HH:MM/);
  });

  test("priceGapBps is symmetric around the reference", () => {
    expect(priceGapBps(212_870_000n, 211_000_000n)).toBe(88n);
    expect(priceGapBps(211_000_000n, 212_870_000n)).toBe(87n);
  });

  test("parseDecimal is exact and cuts extra places", () => {
    expect(parseDecimal("212.87", 6)).toBe(212_870_000n);
    expect(parseDecimal("0.992", 18)).toBe(992n * 10n ** 15n);
    expect(parseDecimal("7", 6)).toBe(7_000_000n);
    expect(parseDecimal("1.1234567", 6)).toBe(1_123_456n);
    expect(() => parseDecimal("1e-5", 6)).toThrow();
  });

  test("the floor rounds up so a bid just under the vault's limit never counts", () => {
    expect(hedgeFloorUsd6(212_870_000n, 100n)).toBe(210_741_300n);
    expect(hedgeCapacityUsd6([{ px: "210.7413", sz: "1" }], 212_870_000n, 100n, 10_000n)).toBe(212_870_000n);
    expect(hedgeCapacityUsd6([{ px: "210.7412", sz: "1" }], 212_870_000n, 100n, 10_000n)).toBe(0n);
  });

  test("decodeMarketStatus reads v8 and v11 and rejects schemas without the field", () => {
    const noBook = { bidUsd6: 0n, bidSize: 0n, askUsd6: 0n, askSize: 0n };
    expect(decodeMarketStatus(fullReport(v8Blob(FEED_V8, 123, 2)))).toEqual({
      feedId: FEED_V8,
      observedAt: 123,
      status: 2,
      book: noBook, // v8 has no top of book
    });
    // v11 carries the equity market's top of book: $212.87 × 1 share each side (USD 6 dec, shares × 1e6)
    expect(decodeMarketStatus(fullReport(v11Blob(FEED_V11, 456, 5)))).toEqual({
      feedId: FEED_V11,
      observedAt: 456,
      status: 5,
      book: { bidUsd6: 212_870_000n, bidSize: 1_000_000n, askUsd6: 212_870_000n, askSize: 1_000_000n },
    });
    const v3 = fullReport(v8Blob(FEED_V8.replace("0008", "0003") as Hex, 1, 2));
    expect(() => decodeMarketStatus(v3)).toThrow(/schema v3/);
  });

  test("authHeaders hashes a POST body into the signature", () => {
    const h = authHeaders("POST", "/api/v1/reports/bulk", '{"a":1}', { apiKey: "k", apiSecret: "s" }, 42);
    // python3: hmac.new(b"s", f"POST /api/v1/reports/bulk {sha256(b'{\"a\":1}').hexdigest()} k 42".encode(), sha256)
    expect(h["X-Authorization-Signature-SHA256"]).toBe("8c9593c43afd26e0609a99c0b869ba8756e613621b7486ac9722b7de0c176bbd");
  });

  // the same bytes are asserted in contracts/test/unit/RiskParams.t.sol, so the TS encoder and the Solidity
  // decoder can't drift apart
  test("report encoding is the layout RiskParams decodes", () => {
    expect(encodeMarketReport({ open: true, hedgeCapacity: 1_234_000_000n, observedAt: 1_800_000_000 })).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001" +
        "00000000000000000000000000000000000000000000000000000000498d5880" +
        "000000000000000000000000000000000000000000000000000000006b49d200",
    );
  });

  test("HyperEVM testnet and mainnet are in the CRE chain registry", () => {
    expect(getNetwork({ chainFamily: "evm", chainSelectorName: "hyperliquid-testnet", isTestnet: true })).toBeTruthy();
    expect(getNetwork({ chainFamily: "evm", chainSelectorName: "hyperliquid-mainnet", isTestnet: false })).toBeTruthy();
  });
});

