/**
 * Frozen type surface for the Seiz3 keeper.
 *
 * All on-chain numbers are bigint. Never Number, never floating point.
 *
 * Units:
 * - USDC amounts: 6 decimals.
 * - NVDAx inventory: 18 decimals.
 * - confirmedShort: Core size units, negative = short.
 * - Morpho price: 1e36-scaled oracle price. `collateral * price / 1e36` yields
 *   borrow-asset units (USDC 6 dec) for an 18-dec collateral / 6-dec loan market.
 * - LLTV: 1e18 WAD (0.8e18 = 80%).
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Mirrors ISeiz3Vault.Pending. */
export interface PendingHedge {
  readonly delta: bigint;
  readonly sentBlock: bigint;
  readonly sentAt: bigint;
  readonly tries: bigint;
}

/** Mirrors RiskParams.Params, read with `RiskParams.get()`. */
export interface Risk {
  readonly maxLiquidation: bigint; // max seized notional per liquidation, USDC 6 dec
  readonly maxUnhedged: bigint; // Core size units; also caps the unwind chunk
  readonly leverage: bigint;
  readonly marginBufferBps: bigint;
  readonly minDiscountBps: bigint;
  readonly oracleBandBps: bigint;
  readonly hedgeCapBps: bigint;
  readonly maxSlippageBps: bigint;
  readonly maxTries: bigint;
  readonly orderDelaySec: bigint;
  readonly cooldownOpenSec: bigint;
  readonly cooldownClosedSec: bigint;
  readonly withdrawReserve: bigint; // USDC 6 dec
  readonly maxImpactBps: bigint;
  readonly transitBlocks: bigint;
}

export interface BorrowerState {
  readonly address: Address;
  readonly collateral: bigint;
  /** Borrow shares converted to assets, rounded up the way Morpho's health check does. */
  readonly borrowAssets: bigint;
}

export interface MarketState {
  readonly id: Hex;
  readonly price: bigint;
  readonly lltv: bigint;
}

export interface VaultState {
  readonly blockNumber: bigint;
  /** The contract's clock. Every timing check compares against this, not the keeper's wall clock. */
  readonly blockTimestamp: bigint;
  readonly vault: Address;
  readonly pendingHedge: PendingHedge;
  readonly inventory: bigint;
  readonly confirmedShort: bigint;
  /** vault.pauseFlags(): 1 hedge stuck, 2 margin low, 4 owner. 0 = not paused. */
  readonly pauseFlags: bigint;
  readonly lastUnwindAt: bigint;
  /** usdc.balanceOf(vault) */
  readonly idleUsdc: bigint;
  /** vault.coreUsdc(): xyz account value (incl. the short's uPnL) + Core spot USDC */
  readonly coreUsdc: bigint;
  /** vault.marginShortfall(): USDC missing to hold the target short with buffer */
  readonly marginShortfall: bigint;
  /** vault.marginTarget(): margin for the target short plus one max-size liquidation */
  readonly marginTarget: bigint;
  /** RiskParams.marketOpen() */
  readonly marketOpen: boolean;
  readonly risk: Risk;
  readonly market: MarketState;
  readonly borrowers: readonly BorrowerState[];
}

/** Computed rows the keeper always logs before asking the risk engine. */
export interface BorrowerReport {
  readonly address: Address;
  readonly collateral: bigint;
  readonly borrowAssets: bigint;
  readonly lltv: bigint;
  readonly lltvBps: bigint;
  readonly collateralValueUsdc: bigint;
  readonly ltvBps: bigint;
  readonly liquidatable: boolean;
  readonly maxSeizedAssets: bigint;
  readonly label?: string;
}

export interface ScanReport {
  readonly ts: bigint;
  readonly blockNumber: bigint;
  readonly morpho: Address;
  readonly marketId: Hex;
  readonly price: bigint;
  readonly lltv: bigint;
  readonly borrowers: readonly BorrowerReport[];
  readonly liquidatableCount: number;
}

export type Action =
  | { readonly kind: "syncHedge" }
  | { readonly kind: "topUpMargin"; readonly amount: bigint }
  | {
      readonly kind: "liquidate";
      readonly marketId: Hex;
      readonly borrower: Address;
      readonly seizedAssets: bigint;
    }
  | { readonly kind: "unwindStep" }
  | { readonly kind: "withdrawMargin"; readonly amount: bigint };

export type ActionKind = Action["kind"];

export interface DeploymentBorrower {
  readonly address: Address;
  readonly label?: string;
}

/** What the keeper takes from deployments/<network>.json (Deploy.s.sol + CreateMarkets.s.sol). */
export interface DeploymentInfo {
  readonly chainId: bigint;
  readonly vault: Address;
  readonly morpho: Address;
  /** markets.C_seiz3.id: the one market the vault allow-lists */
  readonly marketId: Hex;
  /** Morpho can't enumerate a market's borrowers; setup scripts list the ones they opened. */
  readonly borrowers: readonly DeploymentBorrower[];
  /** Block the markets were created in, if the deployment file records it. */
  readonly startBlock?: bigint;
  /** xyz:NVDA size decimals and order id (deployments hypercore). */
  readonly szDecimals?: number;
  readonly perpAsset?: number;
  /** Seiz3Hook on the vault's pool (deployments hook), if the deployment has one. */
  readonly hook?: Address;
}

export interface Config {
  // chain / identity
  readonly rpcUrl: string;
  readonly chainId: bigint;
  readonly vault: Address;
  readonly morpho: Address;
  readonly deploymentsPath: string;
  readonly keeperPrivateKey: Hex;
  /** Leader-election identity: two keepers share a risk engine; only the leader acts. */
  readonly keeperId: string;
  readonly deployments: DeploymentInfo;

  // risk engine (keeper does not make risk decisions itself)
  readonly riskEngineUrl: string;
  readonly riskEngineTimeoutMs: number;
  readonly riskEngineRetries: number;

  // Morpho RWA position discovery (GraphQL mirror of the on-chain market)
  readonly morphoApiEnabled: boolean;
  readonly morphoApiUrl: string;
  readonly morphoApiTimeoutMs: number;
  readonly morphoApiIntervalMs: number;
  readonly morphoApiMaxPositions: number;

  // on-chain borrower discovery: Morpho Borrow events on the market (borrowerScan.ts)
  readonly borrowerScanFromBlock: bigint | null;
  readonly borrowerScanPageBlocks: bigint;
  readonly borrowerScanPagesPerTick: number;
  readonly borrowerScanIntervalMs: number;
  readonly logsRpcUrl: string;
  /** Addresses to check every tick, written by the API (/try connects, faucet drips). */
  readonly watchFile: string | null;
  /** Buy-back liquidity gate: Hyperliquid info API (null: off), the perp, and where to ask the market maker. */
  readonly hlInfoUrl: string | null;
  readonly hlCoin: string;
  readonly askRequestFile: string | null;
  readonly unwindChunkEstimateUnits: bigint;

  // loop
  readonly tickMs: number;
  readonly txTimeoutMs: number;
  readonly healthPort: number;
  readonly dryRun: boolean;
  readonly killSwitchFile: string;
  readonly killSwitchEnv: boolean;

  // money buffers, 6 dec
  readonly idleReserveUsdc: bigint;
  /** Slack kept on Core above the vault's marginTarget before margin is sent back. */
  readonly coreReserveUsdc: bigint;

  // safety
  readonly maxActionsPerMinute: number;
  readonly maxConsecutiveReverts: number;
  /** After this long since the last failure an open breaker lets one send through; 0 never. */
  readonly breakerCooldownMs: number;
  /** Buyers first: seconds after a liquidation the keeper waits for a hook fill before pushing stock (0: off). */
  readonly buyerWindowSec: number;
  readonly minSignerBalanceWei: bigint;
  readonly gasLimitCap: bigint;
  readonly gasLimitMarginBps: bigint;
}

export type PolicyConfig = Pick<Config, "idleReserveUsdc" | "coreReserveUsdc">;

/** What the keeper sends to the risk engine. BigInt-safe on the wire. */
export interface RiskRequest {
  readonly ts: bigint;
  readonly chainId: bigint;
  readonly blockNumber: bigint;
  readonly vault: Address;
  readonly morpho: Address;
  readonly state: {
    readonly pendingHedge: PendingHedge;
    readonly inventory: bigint;
    readonly confirmedShort: bigint;
    readonly pauseFlags: bigint;
    readonly lastUnwindAt: bigint;
    readonly idleUsdc: bigint;
    readonly coreUsdc: bigint;
    readonly marginShortfall: bigint;
    readonly marginTarget: bigint;
    readonly marketOpen: boolean;
    readonly risk: Risk;
    readonly market: MarketState;
    readonly borrowers: readonly BorrowerReport[];
  };
  readonly keeper: {
    readonly idleReserveUsdc: bigint;
    readonly coreReserveUsdc: bigint;
    /** The block timestamp the state was read at. */
    readonly now: bigint;
  };
}

/** What the risk engine returns. `confidenceBps` is the engine's own score. */
export interface RiskDecision {
  readonly action: Action | null;
  readonly reason: string;
  readonly confidenceBps?: bigint;
  readonly engineVersion?: string;
}

export type DecisionReason =
  | "sync-ready"
  | "wait-same-block"
  | "wait-order-delay"
  | "clear-pause"
  | "paused"
  | "topup-ready"
  | "liquidate-ready"
  | "unwind-ready"
  | "unwind-cooldown"
  | "withdraw-ready"
  | "position-open"
  | "core-at-reserve"
  | "idle";

export interface Decision {
  readonly action: Action | null;
  readonly reason: DecisionReason;
}

export type GuardReason =
  | "ok"
  | "vault-paused"
  | "hedge-pending"
  | "no-pending-hedge"
  | "same-block"
  | "order-delay"
  | "no-margin-shortfall"
  | "topup-above-shortfall"
  | "amount-zero"
  | "insufficient-idle"
  | "market-mismatch"
  | "unknown-borrower"
  | "borrower-healthy"
  | "zero-size"
  | "size-exceeds-collateral"
  | "size-exceeds-max-liquidation"
  | "size-exceeds-debt"
  | "size-exceeds-cash"
  | "no-inventory"
  | "cooldown-active"
  | "position-open"
  | "insufficient-core";

export type GuardResult =
  | { readonly ok: true; readonly reason: "ok" }
  | { readonly ok: false; readonly reason: GuardReason };
