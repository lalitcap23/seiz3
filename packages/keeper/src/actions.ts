import type { Address } from "viem";

/** One candidate action per priority slot. `check` reads state; `run` sends at most one tx. */
export interface KeeperAction {
  name: "syncHedge" | "topUpMargin" | "liquidate" | "unwindStep" | "withdrawMargin";
  check(): Promise<boolean>;
  run(): Promise<`0x${string}`>;
}

export interface KeeperContext {
  vault: Address;
  now: () => number; // replaced by the replay clock in --replay mode
}

// Priority order (architecture doc §Keeper bot):
// 1 syncHedge      pendingHedge.delta != 0 && now ≥ sentAt + orderDelay && block > sentBlock
// 2 topUpMargin    margin ratio below buffer
// 3 liquidate      a Morpho position with LTV > LLTV and the vault is idle (eth_call first)
// 4 unwindStep     inventory > 0, cooldown elapsed, pool within band
// 5 withdrawMargin inventory == 0, short == 0, Core USDC above reserve
export function buildActions(_ctx: KeeperContext): KeeperAction[] {
  // TODO: implement each check/run against afterbellVaultAbi via viem simulateContract → writeContract
  return [];
}
