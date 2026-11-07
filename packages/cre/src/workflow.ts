// Seiz3 market feed for the Chainlink Runtime Environment (CRE).
//
// The vault needs two facts it can't read on-chain, and has to trust both:
//   1. Is the US stock market open?  Chainlink Data Streams' `marketStatus` for NVDA, or, while the Data Streams key
//      isn't authorized for the feed, the exchange's regular hours from the config (`marketStatus: "marketHours"`).
//   2. How much can the xyz:NVDA book absorb?  Hyperliquid's l2Book: bids inside the vault's hedge band.
// Optionally (`dataFeed`), Chainlink's free NVDA/USD Data Feed is read as an independent check on HyperCore's oracle.
//
//   cron ─► RiskParams.params() (bands) ─► Hyperliquid l2Book + oracle ─► market status ─► Chainlink Data Feed
//        ─► DON-signed report ─► KeystoneForwarder ─► RiskParams.onReport(open, hedgeCapacity, observedAt)
//
// Every node fetches the off-chain sources on its own; the DON requires the same market status from all of them and
// takes the median of the book. The vault caps each liquidation at the capacity (RiskParams.get), and the Uniswap
// hook prices from the status (RiskParams.marketOpen) — no keeper bot can feed either.

import {
  ConsensusAggregationByFields,
  cre,
  getNetwork,
  identical,
  median,
  TxStatus,
  type Runtime,
} from "@chainlink/cre-sdk";
import { z } from "zod";
import type { Address } from "viem";

import { checkPrice, readDataFeed, type PriceCheck } from "./dataFeed";
import { readHedgeAccount, writeGatewaySnapshot, type HedgeAccountRead } from "./gateway";
import { MARKET_OPEN, readMarketStatus, type MarketStatusRead } from "./datastreams";
import { readHedgeCapacity, type BookRead } from "./hyperliquid";
import { isMarketOpen } from "./marketHours";
import { readRiskBands, writeMarketReport, type MarketReport } from "./riskParams";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
// not z.string().url(): it needs the URL global, which the CRE (Javy) runtime doesn't have
const httpsUrl = z.string().regex(/^https:\/\/[^\s/]+(\/\S*)?$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const chain = { chainSelectorName: z.string(), isTestnet: z.boolean() };

export const configSchema = z
  .object({
    schedule: z.string(), // six-field cron, e.g. "0 */1 * * * *"
    evm: z.object({
      ...chain, // "hyperliquid-testnet" | "hyperliquid-mainnet"
      riskParams: address,
      gasLimit: z.string().default("300000"),
      // the block RiskParams' bands are read at: "latest" on Base Sepolia, whose finalized head trails by hours
      readBlock: z.enum(["finalized", "latest"]).default("finalized"),
    }),
    marketStatus: z.enum(["dataStreams", "marketHours"]),
    dataStreams: z.object({ apiUrl: httpsUrl, feedId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).optional(),
    marketHours: z
      .object({ open: hhmm, close: hhmm, earlyClose: hhmm, holidays: z.array(day), earlyCloses: z.array(day) })
      .optional(),
    dataFeed: z
      .object({ ...chain, proxy: address, enforce: z.boolean(), maxAgeSec: z.number().int().positive() })
      .optional(),
    hyperliquid: z.object({ apiUrl: httpsUrl, dex: z.string(), coin: z.string() }),
    bookShareBps: z.number().int().min(1).max(10_000).default(10_000), // share of the visible depth one hedge may take
    // Base Sepolia (vault on Base, short on HyperCore): also attest the hedge account to HyperCoreGateway (src/gateway.ts)
    gateway: z
      .object({
        address,
        hedgeAccount: address,
        szDecimals: z.number().int().min(0).max(6),
        gasLimit: z.string().default("400000"),
      })
      .optional(),
  })
  .refine((c) => c[c.marketStatus] !== undefined, (c) => ({ message: `marketStatus "${c.marketStatus}" needs its config block` }));

export type Config = z.infer<typeof configSchema>;

/** `ReceiverContractExecutionStatus.SUCCESS` in the EVM capability's protobuf (not exported by the SDK root). */
const RECEIVER_SUCCESS = 0;

export const SECRET_API_KEY = "DATA_STREAMS_API_KEY";
export const SECRET_API_SECRET = "DATA_STREAMS_API_SECRET";

function evmClient(c: { chainSelectorName: string; isTestnet: boolean }) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: c.chainSelectorName, isTestnet: c.isTestnet });
  if (!network) throw new Error(`chain not in the CRE registry: ${c.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function secret(runtime: Runtime<Config>, id: string): string {
  return runtime.getSecret({ id }).result().value;
}

interface Market {
  readonly open: boolean;
  readonly observedAt: number;
  readonly source: string;
  /** v11 streams: the equity market's top of book, e.g. "$186.95 × 450 / $186.97 × 230" (logged, not reported). */
  readonly equityBook?: string;
}

function readMarket(runtime: Runtime<Config>): Market {
  const cfg = runtime.config;
  if (cfg.marketStatus === "marketHours") {
    const now = runtime.now().getTime(); // the DON's agreed clock
    return { open: isMarketOpen(now, cfg.marketHours!), observedAt: Math.floor(now / 1000), source: "market hours" };
  }
  const ds = cfg.dataStreams!;
  const read = runtime
    .runInNodeMode(
      readMarketStatus,
      ConsensusAggregationByFields<MarketStatusRead>({
        status: identical,
        observedAt: median,
        bidUsd6: median,
        bidSize: median,
        askUsd6: median,
        askSize: median,
      }),
    )(ds, { apiKey: secret(runtime, SECRET_API_KEY), apiSecret: secret(runtime, SECRET_API_SECRET) })
    .result();
  const equityBook =
    read.bidUsd6 > 0n && read.askUsd6 > 0n
      ? `$${usd(read.bidUsd6)} × ${shares(read.bidSize)} / $${usd(read.askUsd6)} × ${shares(read.askSize)}`
      : undefined;
  return {
    open: read.status === MARKET_OPEN,
    observedAt: read.observedAt,
    source: `status ${read.status}`,
    ...(equityBook ? { equityBook } : {}),
  };
}

function shares(size1e6: bigint): string {
  return String(Number(size1e6) / 1e6);
}

export function onCronTrigger(runtime: Runtime<Config>): string {
  const cfg = runtime.config;
  const evm = evmClient(cfg.evm);
  const riskParams = cfg.evm.riskParams as Address;

  // the bands the vault works within, from the contract that enforces them
  const bands = readRiskBands(runtime, evm, riskParams, cfg.evm.readBlock);
  runtime.log(`RiskParams ${riskParams}: hedge band ${bands.hedgeCapBps} bps, oracle band ${bands.oracleBandBps} bps`);

  const book = runtime
    .runInNodeMode(
      readHedgeCapacity,
      ConsensusAggregationByFields<BookRead>({ capacityUsd6: median, oracleUsd6: median, observedAt: median }),
    )(cfg.hyperliquid, bands.hedgeCapBps, BigInt(cfg.bookShareBps))
    .result();
  runtime.log(`${cfg.hyperliquid.coin} book: $${usd(book.capacityUsd6)} inside the band, oracle $${usd(book.oracleUsd6)} at ${book.observedAt}`);

  const market = readMarket(runtime);
  runtime.log(`market ${market.open ? "open" : "closed"} (${market.source}) at ${market.observedAt}`);
  if (market.equityBook) runtime.log(`Data Streams NVDA top of book: ${market.equityBook}`);

  let check: PriceCheck | undefined;
  if (cfg.dataFeed) {
    const feed = readDataFeed(runtime, evmClient(cfg.dataFeed), cfg.dataFeed.proxy as Address);
    check = checkPrice(cfg.dataFeed, feed, book.oracleUsd6, bands.oracleBandBps, Math.floor(runtime.now().getTime() / 1000));
    runtime.log(
      `Chainlink Data Feed ${cfg.dataFeed.proxy}: $${usd(feed.priceUsd6)} at ${feed.updatedAt}, ${check.gapBps} bps from HyperCore` +
        (check.blocks ? " → capacity 0" : check.fresh ? (cfg.dataFeed.enforce ? " (within band)" : " (observed, not enforced)") : " (paused feed, not compared)"),
    );
  }

  const report: MarketReport = {
    open: market.open,
    hedgeCapacity: check?.blocks ? 0n : book.capacityUsd6,
    observedAt: Math.min(market.observedAt, book.observedAt), // the report is as old as its oldest half
  };
  const reply = writeMarketReport(runtime, evm, riskParams, report, cfg.evm.gasLimit);
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`RiskParams report failed: ${reply.errorMessage || String(reply.txStatus)}`);
  }
  // the forwarder's transaction can succeed while RiskParams itself reverts (e.g. a report out of order)
  if (reply.receiverContractExecutionStatus !== undefined && reply.receiverContractExecutionStatus !== RECEIVER_SUCCESS) {
    throw new Error(`RiskParams rejected the report: ${reply.errorMessage || "receiver reverted"}`);
  }

  const attested = cfg.gateway ? attestHedgeAccount(runtime, evm) : "";

  const summary =
    `market ${report.open ? "open" : "closed"} (${market.source}), ` +
    `hedge capacity $${usd(report.hedgeCapacity)} within ${bands.hedgeCapBps} bps, observed ${report.observedAt}` +
    (market.equityBook ? `, equity book ${market.equityBook}` : "") +
    (check ? `, Chainlink gap ${check.gapBps} bps` : "") +
    (reply.txHash && reply.txHash.length > 0 ? `, tx ${bytesHex(reply.txHash)}` : "") +
    attested;
  runtime.log(`Seiz3 market feed: ${summary}`);
  return summary;
}

/** The DON's own snapshot of the hedge account → HyperCoreGateway (Base Sepolia). Returns the summary's tail. */
function attestHedgeAccount(runtime: Runtime<Config>, evm: ReturnType<typeof evmClient>): string {
  const cfg = runtime.config;
  const gw = cfg.gateway!;
  const read = runtime
    .runInNodeMode(
      readHedgeAccount,
      ConsensusAggregationByFields<HedgeAccountRead>({
        observedAt: median,
        szi: median,
        entryNtl: median,
        accountValue: median,
        marginUsed: median,
        ntlPos: median,
        spotUsdcWei: median,
        oraclePx: median,
        markPx: median,
        leverage: median,
        exists: identical,
      }),
    )(cfg.hyperliquid, gw)
    .result();
  runtime.log(
    `hedge account ${gw.hedgeAccount}: szi ${read.szi}, account value $${usd(read.accountValue)}, observed ${read.observedAt}`,
  );
  const reply = writeGatewaySnapshot(runtime, evm, gw.address as Address, read, gw.gasLimit);
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`HyperCoreGateway report failed: ${reply.errorMessage || String(reply.txStatus)}`);
  }
  if (reply.receiverContractExecutionStatus !== undefined && reply.receiverContractExecutionStatus !== RECEIVER_SUCCESS) {
    throw new Error(`HyperCoreGateway rejected the snapshot: ${reply.errorMessage || "receiver reverted"}`);
  }
  return (
    `; hedge account szi ${read.szi} attested to the gateway` +
    (reply.txHash && reply.txHash.length > 0 ? ` (tx ${bytesHex(reply.txHash)})` : "")
  );
}

function usd(usd6: bigint): string {
  return (Number(usd6) / 1e6).toFixed(2);
}

function bytesHex(b: Uint8Array): string {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
}
