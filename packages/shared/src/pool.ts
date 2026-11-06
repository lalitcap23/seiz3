/** Uniswap v4 pool maths for the NVDAx/USDC pools, mirrored from contracts/src/libs/UnwindLib.sol. */
import {
  encodeAbiParameters,
  encodePacked,
  hexToBigInt,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";

export interface PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

const WAD = 10n ** 18n;
const Q192 = 1n << 192n;
const SQRT_PRICE_MASK = (1n << 160n) - 1n;
/** TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE: the no-limit bounds for a swap. */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export const extsloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32 value)"]);

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

/** `pools[poolId]` in the PoolManager (v4 StateLibrary: POOLS_SLOT 6, liquidity at +3). Read with `extsload`. */
export function poolSlots(key: PoolKey): { slot0: Hex; liquidity: Hex } {
  const state = keccak256(encodePacked(["bytes32", "uint256"], [poolId(key), 6n]));
  return { slot0: state, liquidity: toHex(hexToBigInt(state) + 3n, { size: 32 }) };
}

/** sqrtPriceX96 out of a raw slot0 word. */
export const slot0SqrtPrice = (slot0: Hex) => hexToBigInt(slot0) & SQRT_PRICE_MASK;

export const nvdaxIsCurrency0 = (key: PoolKey, nvdax: Address) =>
  key.currency0.toLowerCase() === nvdax.toLowerCase();

function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
}

/** USDC (6 dec) per 1 NVDAx → sqrtPriceX96, as UnwindLib.sqrtPriceAt. */
export function sqrtPriceAt(usd6: bigint, nvdax0: boolean): bigint {
  return sqrt(nvdax0 ? (usd6 * Q192) / WAD : (WAD * Q192) / usd6);
}

/** sqrtPriceX96 → USDC (6 dec) per 1 NVDAx, as UnwindLib.usdcPerNvdaxAt. */
export function usdcPerNvdaxAt(sqrtPriceX96: bigint, nvdax0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const p = sqrtPriceX96 * sqrtPriceX96; // × 2^192
  return nvdax0 ? (p * WAD) / Q192 : (WAD * Q192) / p;
}

/**
 * Swap price limit `slipBps` worse than `sqrtPriceX96`: zeroForOne pushes the price (currency1 per currency0) down,
 * oneForZero up. The swap stops there instead of filling at any price.
 */
export function priceLimit(sqrtPriceX96: bigint, zeroForOne: boolean, slipBps: number): bigint {
  const bps = 10_000n + (zeroForOne ? -BigInt(slipBps) : BigInt(slipBps));
  const limit = (sqrtPriceX96 * sqrt((bps << 192n) / 10_000n)) >> 96n;
  if (limit <= MIN_SQRT_PRICE) return MIN_SQRT_PRICE + 1n;
  if (limit >= MAX_SQRT_PRICE) return MAX_SQRT_PRICE - 1n;
  return limit;
}
