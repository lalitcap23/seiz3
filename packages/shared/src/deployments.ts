import { z } from "zod";
import type { Address, Hex } from "viem";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as Address);
const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .transform((s) => s as Hex);

const market = z.object({ id: hex, oracle: address, lltv: z.string() });

export const deploymentSchema = z.object({
  chainId: z.number(),
  usdc: address,
  morpho: address,
  poolManager: address,
  nvdax: address,
  riskParams: address,
  vault: address,
  /** Seiz3HookRemote on the vault's pool. */
  hook: address.optional(),
  poolKey: z.object({
    currency0: address,
    currency1: address,
    fee: z.number(),
    tickSpacing: z.number(),
    hooks: address,
  }),
  hypercore: z.object({
    perpAsset: z.number(),
    perpDexIndex: z.number(),
    szDecimals: z.number(),
  }),
  markets: z.object({ A_naive: market, B_conservative: market, C_seiz3: market }).optional(),
  // what the public tester page calls (RemoteExtras.s.sol / DeployRemote.s.sol)
  faucet: address.optional(),
  swapRouter: address.optional(),
  // DeployRemote.s.sol: HyperCore through the gateway, the short in the hedge account
  hyperCoreGateway: address,
  hedgeAccount: address,
});

export type Deployment = z.infer<typeof deploymentSchema>;
export type MarketName = "A_naive" | "B_conservative" | "C_seiz3";
