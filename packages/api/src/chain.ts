import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  parseAbi,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { afterbellVaultAbi, demoOracleAbi, iMorphoAbi, riskParamsAbi } from "@afterbell/shared/abis";
import { extsloadAbi, poolSlots, type MarketName } from "@afterbell/shared";
import type { DeploymentFile } from "@afterbell/shared/node";

/** Canonical Multicall3: deployed on HyperEVM mainnet and testnet; scripts/local-stack.sh etches it on anvil. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

const PRECOMPILE = {
  markPx: "0x0000000000000000000000000000000000000806",
  oraclePx: "0x0000000000000000000000000000000000000807",
  marginSummary: "0x000000000000000000000000000000000000080F",
  position2: "0x0000000000000000000000000000000000000813",
} as const;

export const MARKETS: readonly MarketName[] = ["A_naive", "B_conservative", "C_afterbell"];
const HEDGE_STATES = ["Idle", "Pending", "Retrying", "Paused"] as const;

export interface MarketRead {
  name: MarketName;
  lltv: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  price: bigint; // Morpho 1e36 scale
  borrower: Address | null;
  borrowShares: bigint;
  collateral: bigint;
}

export interface CoreRead {
  oraclePx: bigint;
  markPx: bigint;
  szi: bigint;
  entryNtl: bigint; // USD, 6 dec
  accountValue: bigint; // USD, 6 dec
  marginUsed: bigint;
}

export interface ChainRead {
  blockNumber: bigint;
  timestamp: bigint;
  markets: MarketRead[];
  vault: {
    inventory: bigint;
    confirmedShort: bigint;
    pendingHedge: { delta: bigint; sentBlock: bigint; sentAt: bigint; tries: number };
    hedgeState: (typeof HEDGE_STATES)[number];
    paused: boolean;
    totalAssets: bigint | null; // reverts when a HyperCore read fails
    totalSupply: bigint;
    decimals: number;
    marginFloat: bigint;
  };
  marketOpen: boolean;
  pool: { sqrtPriceX96: bigint; liquidity: bigint };
  /** Market A's own weekend pool (testnet); null where it shares the vault's pool. */
  thinPool: { sqrtPriceX96: bigint; liquidity: bigint } | null;
  core: CoreRead | null; // null without HyperCore precompiles
}

interface Call {
  name: string;
  target: Address;
  callData: Hex;
  decode: (data: Hex) => unknown;
}

function contract(name: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Call {
  return {
    name,
    target: address,
    callData: encodeFunctionData({ abi, functionName, args } as never),
    decode: (data) => decodeFunctionResult({ abi, functionName, data } as never),
  };
}

/** HyperCore read precompiles take bare ABI-encoded args, no selector. */
function precompile(name: string, address: Address, inputs: string, outputs: string, args: readonly unknown[]): Call {
  return {
    name,
    target: address,
    callData: encodeAbiParameters(parseAbiParameters(inputs), args as never),
    decode: (data) => decodeAbiParameters(parseAbiParameters(outputs), data),
  };
}

/** Everything the snapshot needs from HyperEVM and HyperCore, in one eth_call at one block. */
export async function readChain(client: PublicClient, dep: DeploymentFile): Promise<ChainRead> {
  const perpIndex = dep.hypercore.perpAsset >= 100_000 ? dep.hypercore.perpAsset - 100_000 : dep.hypercore.perpAsset;
  const slots = poolSlots(dep.poolKey);
  const borrowerOf = (name: MarketName) => dep.borrowers.find((b) => b.label === name)?.address ?? null;
  const vault = (fn: string) => contract(`vault.${fn}`, dep.vault, afterbellVaultAbi, fn);

  const calls: Call[] = [
    contract("blockNumber", MULTICALL3, multicall3Abi, "getBlockNumber"),
    contract("timestamp", MULTICALL3, multicall3Abi, "getCurrentBlockTimestamp"),
    vault("inventory"),
    vault("confirmedShort"),
    vault("pendingHedge"),
    vault("hedgeState"),
    vault("paused"),
    vault("totalAssets"),
    vault("totalSupply"),
    vault("decimals"),
    vault("marginFloat"),
    contract("risk.marketOpen", dep.riskParams, riskParamsAbi, "marketOpen"),
    contract("pool.slot0", dep.poolManager, extsloadAbi, "extsload", [slots.slot0]),
    contract("pool.liquidity", dep.poolManager, extsloadAbi, "extsload", [slots.liquidity]),
    precompile("core.oraclePx", PRECOMPILE.oraclePx, "uint32", "uint64", [perpIndex]),
    precompile("core.markPx", PRECOMPILE.markPx, "uint32", "uint64", [perpIndex]),
    precompile("core.position", PRECOMPILE.position2, "address, uint32", "int64, uint64, int64, uint32, bool", [
      dep.vault,
      perpIndex,
    ]),
    precompile(
      "core.marginSummary",
      PRECOMPILE.marginSummary,
      "uint32, address",
      "int64, uint64, uint64, int64",
      [dep.hypercore.perpDexIndex, dep.vault],
    ),
    ...MARKETS.flatMap((name) => {
      const m = dep.markets[name];
      const borrower = borrowerOf(name);
      return [
        contract(`${name}.market`, dep.morpho, iMorphoAbi, "market", [m.id]),
        contract(`${name}.price`, m.oracle, demoOracleAbi, "price"),
        borrower === null
          ? contract(`${name}.noBorrower`, MULTICALL3, multicall3Abi, "getBlockNumber") // keeps the stride fixed
          : contract(`${name}.position`, dep.morpho, iMorphoAbi, "position", [m.id, borrower]),
      ];
    }),
  ];
  const thinSlots = dep.thinPoolKey ? poolSlots(dep.thinPoolKey) : null;
  if (thinSlots) {
    calls.push(
      contract("thinPool.slot0", dep.poolManager, extsloadAbi, "extsload", [thinSlots.slot0]),
      contract("thinPool.liquidity", dep.poolManager, extsloadAbi, "extsload", [thinSlots.liquidity]),
    );
  }

  const data = await client.call({
    to: MULTICALL3,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
    }),
  });
  if (data.data === undefined) throw new Error(`no Multicall3 at ${MULTICALL3}`);
  const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: data.data });

  let i = 0;
  const next = (): unknown => {
    const call = calls[i];
    const result = results[i++];
    if (call === undefined || result === undefined || !result.success) {
      throw new Error(`read ${call?.name ?? i} failed`);
    }
    return call.decode(result.returnData);
  };
  const optional = (): unknown => {
    try {
      return next();
    } catch {
      return null;
    }
  };
  const big = (v: unknown) => v as bigint;

  const blockNumber = big(next());
  const timestamp = big(next());
  const inventory = big(next());
  const confirmedShort = big(next());
  const [delta, sentBlock, sentAt, tries] = next() as readonly [bigint, bigint, bigint, number];
  const hedgeState = HEDGE_STATES[Number(next())] ?? "Idle";
  const paused = next() as boolean;
  const totalAssets = optional() as bigint | null;
  const totalSupply = big(next());
  const decimals = Number(next());
  const marginFloat = big(next());
  const marketOpen = next() as boolean;
  const slot0 = hexToBigInt(next() as Hex);
  const liquidity = hexToBigInt(next() as Hex) & ((1n << 128n) - 1n);

  const oraclePx = optional() as readonly [bigint] | null;
  const markPx = optional() as readonly [bigint] | null;
  const position = optional() as readonly [bigint, bigint, bigint, number, boolean] | null;
  const summary = optional() as readonly [bigint, bigint, bigint, bigint] | null;
  const core =
    oraclePx && markPx && position && summary
      ? {
          oraclePx: oraclePx[0],
          markPx: markPx[0],
          szi: position[0],
          entryNtl: position[1],
          accountValue: summary[0],
          marginUsed: summary[1],
        }
      : null;

  // IMorpho returns the Market and Position structs, which decode as named objects
  const markets = MARKETS.map((name): MarketRead => {
    const market = next() as { totalBorrowAssets: bigint; totalBorrowShares: bigint };
    const price = big(next());
    const borrower = borrowerOf(name);
    const position = borrower === null ? (next(), null) : (next() as { borrowShares: bigint; collateral: bigint });
    return {
      name,
      lltv: BigInt(dep.markets[name].lltv),
      totalBorrowAssets: market.totalBorrowAssets,
      totalBorrowShares: market.totalBorrowShares,
      price,
      borrower,
      borrowShares: position?.borrowShares ?? 0n,
      collateral: position?.collateral ?? 0n,
    };
  });

  const thinPool = thinSlots
    ? {
        sqrtPriceX96: hexToBigInt(next() as Hex) & ((1n << 160n) - 1n),
        liquidity: hexToBigInt(next() as Hex) & ((1n << 128n) - 1n),
      }
    : null;

  return {
    blockNumber,
    timestamp,
    markets,
    thinPool,
    vault: {
      inventory,
      confirmedShort,
      pendingHedge: { delta, sentBlock, sentAt, tries: Number(tries) },
      hedgeState,
      paused,
      totalAssets,
      totalSupply,
      decimals,
      marginFloat,
    },
    marketOpen,
    pool: { sqrtPriceX96: slot0 & ((1n << 160n) - 1n), liquidity },
    core,
  };
}
