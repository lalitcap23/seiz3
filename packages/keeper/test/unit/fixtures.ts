import type {
  Address,
  BorrowerState,
  Config,
  Hex,
  MarketState,
  PendingHedge,
  Risk,
  VaultState,
} from "../../src/types.js";

export const VAULT = "0x00000000000000000000000000000000000000aa" as Address;
export const MORPHO = "0x00000000000000000000000000000000000000bb" as Address;
export const BORROWER_A = "0x00000000000000000000000000000000000000b1" as Address;
export const BORROWER_B = "0x00000000000000000000000000000000000000b2" as Address;
export const MARKET_ID = `0x${"11".repeat(32)}` as Hex;
export const OTHER_MARKET_ID = `0x${"22".repeat(32)}` as Hex;
export const DUMMY_KEY = `0x${"01".repeat(32)}` as Hex;

export const PRICE_100 = 100_000000n * 10n ** 18n; // $100 per NVDAx, Morpho 1e36
export const LLTV_80 = 8000n * 10n ** 14n;
export const USDC = (whole: number) => BigInt(whole) * 1_000000n;
export const NVDAX = (whole: number) => BigInt(whole) * 10n ** 18n;

export const NOW = 1_700_000_000n;

/** DeployHelpers.defaultRisk() with a small maxLiquidation so caps are easy to hit. */
export const baseRisk: Risk = {
  maxLiquidation: USDC(1000),
  maxUnhedged: 2000n,
  leverage: 3n,
  marginBufferBps: 2000n,
  minDiscountBps: 300n,
  oracleBandBps: 150n,
  hedgeCapBps: 100n,
  maxSlippageBps: 100n,
  maxTries: 3n,
  orderDelaySec: 5n,
  cooldownOpenSec: 30n,
  cooldownClosedSec: 300n,
  withdrawReserve: USDC(500),
  maxImpactBps: 50n,
  transitBlocks: 1n,
};

export const baseMarket: MarketState = {
  id: MARKET_ID,
  price: PRICE_100,
  lltv: LLTV_80,
};

export const basePending: PendingHedge = {
  delta: 0n,
  sentBlock: 0n,
  sentAt: 0n,
  tries: 0n,
};

export const baseConfig: Config = {
  rpcUrl: "http://localhost:8545",
  chainId: 31337n,
  vault: VAULT,
  morpho: MORPHO,
  deploymentsPath: "/shared/deployments.json",
  keeperPrivateKey: DUMMY_KEY,
  deployments: {
    chainId: 31337n,
    vault: VAULT,
    morpho: MORPHO,
    marketId: MARKET_ID,
    borrowers: [
      { address: BORROWER_A, label: "liquidatable" },
      { address: BORROWER_B, label: "healthy" },
    ],
  },
  riskEngineUrl: "http://localhost:8081",
  riskEngineTimeoutMs: 2000,
  riskEngineRetries: 2,
  morphoApiEnabled: false,
  morphoApiUrl: "https://blue-api.morpho.org/graphql",
  morphoApiTimeoutMs: 5000,
  morphoApiIntervalMs: 5_000,
  morphoApiMaxPositions: 100,
  borrowerScanFromBlock: null,
  borrowerScanPageBlocks: 500n,
  borrowerScanPagesPerTick: 2,
  borrowerScanIntervalMs: 0,
  logsRpcUrl: "http://127.0.0.1:8545",
  watchFile: null,
  hlInfoUrl: null,
  hlCoin: "xyz:NVDA",
  askRequestFile: null,
  unwindChunkEstimateUnits: 100n,
  tickMs: 1000,
  txTimeoutMs: 60_000,
  healthPort: 9090,
  dryRun: true,
  killSwitchFile: "/shared/KILL",
  killSwitchEnv: false,
  idleReserveUsdc: USDC(10),
  coreReserveUsdc: USDC(10),
  maxActionsPerMinute: 6,
  maxConsecutiveReverts: 3,
  minSignerBalanceWei: 10n ** 15n,
  gasLimitCap: 3_000_000n,
  gasLimitMarginBps: 2500n,
};

/** Idle vault: no stock, no short, margin exactly at target (1000 × 1.2 / 3 = 400 USDC). */
export const baseState: VaultState = {
  blockNumber: 1000n,
  blockTimestamp: NOW,
  vault: VAULT,
  pendingHedge: basePending,
  inventory: 0n,
  confirmedShort: 0n,
  pauseFlags: 0n,
  lastUnwindAt: 0n,
  idleUsdc: USDC(100_000),
  coreUsdc: USDC(400),
  marginShortfall: 0n,
  marginTarget: USDC(400),
  marketOpen: true,
  risk: baseRisk,
  market: baseMarket,
  borrowers: [],
};

/** A borrower whose LTV is above the 80% LLTV at $100/share. */
export function liquidatableBorrower(address: Address = BORROWER_A): BorrowerState {
  return { address, collateral: NVDAX(10), borrowAssets: USDC(900) };
}

/** A borrower whose LTV is below the 80% LLTV: max borrow 800, owes 700. */
export function healthyBorrower(address: Address = BORROWER_B): BorrowerState {
  return { address, collateral: NVDAX(10), borrowAssets: USDC(700) };
}

/**
 * Morpho repays seized × price / LIF, LIF = 1 / (1 − 0.3 × 0.2) at 80% LLTV, so seizing all
 * 10 NVDAx of borrower A would repay 940 USDC against 900 owed. The most it can take:
 * floor(899.999999 × 1.0638…) = 957.446807 USDC of collateral → 9.57446807 NVDAx.
 */
export const BORROWER_A_MAX_SEIZE = 9_574_468_070_000_000_000n;

type StateOverrides = Omit<Partial<VaultState>, "risk" | "market" | "pendingHedge"> & {
  risk?: Partial<Risk>;
  market?: Partial<MarketState>;
  pendingHedge?: Partial<PendingHedge>;
};

export function makeState(overrides: StateOverrides = {}): VaultState {
  const { risk, market, pendingHedge, ...rest } = overrides;
  return {
    ...baseState,
    ...rest,
    risk: { ...baseRisk, ...risk },
    market: { ...baseMarket, ...market },
    pendingHedge: { ...basePending, ...pendingHedge },
    borrowers: rest.borrowers ?? baseState.borrowers,
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...baseConfig, ...overrides };
}

/** A pending hedge that is ready to sync (earlier block, delay elapsed). */
export function readyPending(overrides: Partial<PendingHedge> = {}): PendingHedge {
  return {
    delta: -10_000n,
    sentBlock: 999n,
    sentAt: NOW - 10n,
    tries: 1n,
    ...overrides,
  };
}
