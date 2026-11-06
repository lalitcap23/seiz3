import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "function pendingHedge() view returns (int64 delta, uint64 sentBlock, uint64 sentAt, uint8 tries)",
  "function inventory() view returns (uint256)",
  "function confirmedShort() view returns (int64)",
  "function paused() view returns (bool)",
  "function lastUnwindAt() view returns (uint64)",
  "function idleUsdc() view returns (uint256)",
  "function coreUsdc() view returns (uint256)",
  "function marginRatioBps() view returns (uint256)",
  "function marketOpen() view returns (bool)",
  "function risk() view returns (uint256 maxLiquidation, uint32 hedgeLeverage, uint32 marginBufferBps, uint32 maxUnhedgedBps, uint32 maxSlippageBps, uint32 oracleBandBps, uint8 maxTries, uint32 orderDelaySec, uint32 unwindCooldownSec)",
  "function marketId() view returns (bytes32)",
  "function poolPriceInBand() view returns (bool)",
  "function szDecimals() view returns (uint8)",
  "function liquidate(bytes32 marketId, address borrower, uint256 seizedAssets)",
  "function syncHedge()",
  "function unwindStep()",
  "function topUpMargin(uint256 amount)",
  "function withdrawMargin(uint256 amount)",
  "event LiquidationTaken(bytes32 indexed marketId, address indexed borrower, uint256 seized, uint256 repaid)",
  "event HedgeSent(int64 delta, uint8 tries)",
  "event HedgeConfirmed(int64 actual, int64 target)",
  "event HedgeStuck(int64 gap)",
  "event Unwound(uint256 chunk, uint256 usdcOut)",
  "event MarginMoved(int256 amount)",
] as const);

export const morphoAbi = parseAbi([
  "function price() view returns (uint256)",
  "function lltv() view returns (uint256)",
  "function borrowerCount() view returns (uint256)",
  "function borrowerAt(uint256 index) view returns (address)",
  "function getBorrower(address borrower) view returns (uint256 collateral, uint256 borrowAssets)",
] as const);

export const morphoBlueAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
] as const);

export const oracleAbi = parseAbi([
  "function price() view returns (uint256)",
] as const);

export type VaultAbi = typeof vaultAbi;
export type MorphoAbi = typeof morphoAbi;
