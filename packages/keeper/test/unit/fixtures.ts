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

export const baseRisk: Risk = {
  maxLiquidation: USDC(1000),
  hedgeLeverage: 3n,
  marginBufferBps: 1000n,
  maxUnhedgedBps: 200n,
  maxSlippageBps: 100n,
  oracleBandBps: 200n,
  maxTries: 3n,
  orderDelaySec: 5n,
  unwindCooldownSec: 300n,
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
    lltv: LLTV_80,
    price: PRICE_100,
    szDecimals: 2n,
    orderDelaySec: 5n,
    unwindCooldownOpenSec: 30n,
    borrowers: [
      { address: BORROWER_A, collateral: NVDAX(10), borrowAssets: USDC(900), label: "liquidatable" },
      { address: BORROWER_B, collateral: NVDAX(10), borrowAssets: USDC(700), label: "healthy" },
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
  tickMs: 1000,
  txTimeoutMs: 60_000,
  healthPort: 9090,
  dryRun: true,
  killSwitchFile: "/shared/KILL",
  killSwitchEnv: false,
  idleReserveUsdc: USDC(10),
  coreReserveUsdc: USDC(10),
  topUpUsdc: USDC(1000),
  maxActionsPerMinute: 6,
  maxConsecutiveReverts: 3,
  minSignerBalanceWei: 10n ** 15n,
  gasLimitCap: 3_000_000n,
  gasLimitMarginBps: 2500n,
  unwindCooldownOpenSec: 30n,
};

export const baseState: VaultState = {
  blockNumber: 1000n,
  vault: VAULT,
  pendingHedge: basePending,
  inventory: 0n,
  confirmedShort: 0n,
  paused: false,
  lastUnwindAt: 0n,
  idleUsdc: USDC(100_000),
  coreUsdc: 0n,
  marginRatioBps: 5000n,
  marketOpen: true,
  poolPriceInBand: true,
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

export const NOW = 1_700_000_000n;

/** A pending hedge that is ready to sync (earlier block, delay elapsed). */
export function readyPending(overrides: Partial<PendingHedge> = {}): PendingHedge {
  return {
    delta: -NVDAX(10),
    sentBlock: 999n,
    sentAt: NOW - 10n,
    tries: 1n,
    ...overrides,
  };
}
