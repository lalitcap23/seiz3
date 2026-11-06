// Afterbell market feed for the Chainlink Runtime Environment (CRE).
//
// The vault needs two facts it can't read on-chain, and has to trust both:
//   1. Is the US stock market open?  Chainlink Data Streams' `marketStatus` for NVDA.
//   2. How much can the xyz:NVDA book absorb?  Hyperliquid's l2Book: bids inside the vault's hedge band.
//
//   cron ─► RiskParams.params() (hedge band) ─► Data Streams marketStatus ─► Hyperliquid l2Book + oracle
//        ─► DON-signed report ─► KeystoneForwarder ─► RiskParams.onReport(open, hedgeCapacity, observedAt)
//
// Every node fetches both sources on its own; the DON requires the same market status from all of them and takes
// the median capacity. The vault caps each liquidation at the capacity (RiskParams.get), and the Uniswap hook prices
// from the status (RiskParams.marketOpen) — no keeper bot can feed either.

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

import { MARKET_OPEN, readMarketStatus, type MarketStatusRead } from "./datastreams";
import { readHedgeCapacity, type BookRead } from "./hyperliquid";
import { readHedgeCapBps, writeMarketReport, type MarketReport } from "./riskParams";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
// not z.string().url(): it needs the URL global, which the CRE (Javy) runtime doesn't have
const httpsUrl = z.string().regex(/^https:\/\/[^\s/]+(\/\S*)?$/);

export const configSchema = z.object({
  schedule: z.string(), // six-field cron, e.g. "0 */1 * * * *"
  evm: z.object({
    chainSelectorName: z.string(), // "hyperliquid-testnet" | "hyperliquid-mainnet"
    isTestnet: z.boolean(),
    riskParams: address,
    gasLimit: z.string().default("300000"),
  }),
  dataStreams: z.object({
    apiUrl: httpsUrl,
    feedId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
  hyperliquid: z.object({
    apiUrl: httpsUrl,
    dex: z.string(),
    coin: z.string(),
  }),
  bookShareBps: z.number().int().min(1).max(10_000).default(10_000), // share of the visible depth one hedge may take
});

export type Config = z.infer<typeof configSchema>;

export const SECRET_API_KEY = "DATA_STREAMS_API_KEY";
export const SECRET_API_SECRET = "DATA_STREAMS_API_SECRET";

function secret(runtime: Runtime<Config>, id: string): string {
  return runtime.getSecret({ id }).result().value;
}

export function onCronTrigger(runtime: Runtime<Config>): string {
  const cfg = runtime.config;
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: cfg.evm.chainSelectorName,
    isTestnet: cfg.evm.isTestnet,
  });
  if (!network) throw new Error(`chain not in the CRE registry: ${cfg.evm.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const riskParams = cfg.evm.riskParams as Address;

  // the band the vault's hedge order is limited to, from the contract that enforces it
  const hedgeCapBps = readHedgeCapBps(runtime, evm, riskParams);
  runtime.log(`RiskParams ${riskParams}: hedge band ${hedgeCapBps} bps`);

  const book = runtime
    .runInNodeMode(
      readHedgeCapacity,
      ConsensusAggregationByFields<BookRead>({ capacityUsd6: median, observedAt: median }),
    )(cfg.hyperliquid, hedgeCapBps, BigInt(cfg.bookShareBps))
    .result();
  runtime.log(`${cfg.hyperliquid.coin} book: $${Number(book.capacityUsd6) / 1e6} inside the band at ${book.observedAt}`);

  const market = runtime
    .runInNodeMode(
      readMarketStatus,
      ConsensusAggregationByFields<MarketStatusRead>({ status: identical, observedAt: median }),
    )(cfg.dataStreams, { apiKey: secret(runtime, SECRET_API_KEY), apiSecret: secret(runtime, SECRET_API_SECRET) })
    .result();
  runtime.log(`Data Streams ${cfg.dataStreams.feedId.slice(0, 10)}…: marketStatus ${market.status} at ${market.observedAt}`);

  const report: MarketReport = {
    open: market.status === MARKET_OPEN,
    hedgeCapacity: book.capacityUsd6,
    observedAt: Math.min(market.observedAt, book.observedAt), // the report is as old as its oldest half
  };
  const reply = writeMarketReport(runtime, evm, riskParams, report, cfg.evm.gasLimit);
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`RiskParams report failed: ${reply.errorMessage || String(reply.txStatus)}`);
  }

  const summary =
    `market ${report.open ? "open" : "closed"} (status ${market.status}), ` +
    `hedge capacity $${Number(report.hedgeCapacity) / 1e6} within ${hedgeCapBps} bps, observed ${report.observedAt}`;
  runtime.log(`Afterbell market feed: ${summary}`);
  return summary;
}

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
}
