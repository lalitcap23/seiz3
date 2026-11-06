// Chainlink Data Feeds: the free, on-chain NVDA/USD price (e.g. "NVDA-USD (24/5)" on Ethereum), read by the DON through
// the EVM capability. It is an independent check on HyperCore's oracle, the price the vault buys and hedges at: when
// the two disagree by more than the vault's own oracle band, the report carries zero hedge capacity and the vault
// stops buying. The check only applies while the feed is fresh, because a 24/5 feed doesn't update on weekends,
// which is exactly when Afterbell has to keep working.

import { bytesToHex, encodeCallMsg, LAST_FINALIZED_BLOCK_NUMBER, type EVMClient, type Runtime } from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";

export interface DataFeedConfig {
  readonly chainSelectorName: string; // where the feed lives, e.g. "ethereum-mainnet"
  readonly isTestnet: boolean;
  readonly proxy: string; // the feed's proxy (AggregatorV3Interface)
  readonly enforce: boolean; // zero the capacity on a price gap (off where HyperCore's oracle isn't the real price)
  readonly maxAgeSec: number; // older than this the feed is treated as paused and not compared
}

export const AGGREGATOR_V3_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

export interface FeedRead {
  readonly priceUsd6: bigint;
  readonly updatedAt: number; // unix seconds
}

function call(runtime: Runtime<unknown>, evm: EVMClient, proxy: Address, data: Hex): Hex {
  const reply = evm
    .callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to: proxy, data }), blockNumber: LAST_FINALIZED_BLOCK_NUMBER })
    .result();
  return bytesToHex(reply.data);
}

export function readDataFeed(runtime: Runtime<unknown>, evm: EVMClient, proxy: Address): FeedRead {
  const decimals = decodeFunctionResult({
    abi: AGGREGATOR_V3_ABI,
    functionName: "decimals",
    data: call(runtime, evm, proxy, encodeFunctionData({ abi: AGGREGATOR_V3_ABI, functionName: "decimals" })),
  });
  const [, answer, , updatedAt] = decodeFunctionResult({
    abi: AGGREGATOR_V3_ABI,
    functionName: "latestRoundData",
    data: call(runtime, evm, proxy, encodeFunctionData({ abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" })),
  });
  if (answer <= 0n) throw new Error(`data feed ${proxy}: no price (${answer})`);
  return { priceUsd6: (answer * 10n ** 6n) / 10n ** BigInt(decimals), updatedAt: Number(updatedAt) };
}

/** |a − b| / b in bps. */
export function priceGapBps(a: bigint, b: bigint): bigint {
  return ((a > b ? a - b : b - a) * 10_000n) / b;
}

export interface PriceCheck {
  readonly feed: FeedRead;
  readonly gapBps: bigint;
  readonly fresh: boolean;
  readonly blocks: boolean; // zero the hedge capacity
}

export function checkPrice(cfg: DataFeedConfig, feed: FeedRead, coreOracleUsd6: bigint, bandBps: bigint, nowSec: number): PriceCheck {
  const gapBps = priceGapBps(coreOracleUsd6, feed.priceUsd6);
  const fresh = nowSec - feed.updatedAt <= cfg.maxAgeSec;
  return { feed, gapBps, fresh, blocks: cfg.enforce && fresh && gapBps > bandBps };
}
