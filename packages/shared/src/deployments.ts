import { z } from "zod";
import type { Address, Hex } from "viem";
import testnet from "../../../deployments/testnet.json" with { type: "json" };
import mainnet from "../../../deployments/mainnet.json" with { type: "json" };
import type { Network } from "./chains.js";

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
  /** AfterbellHook on the vault's pool (Deploy.s.sol since the hook); absent in older deployments. */
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
  markets: z.object({ A_naive: market, B_conservative: market, C_afterbell: market }).optional(),
  // testnet extras (TestnetExtras.s.sol): what the public tester page calls
  faucet: address.optional(),
  swapRouter: address.optional(),
});

export type Deployment = z.infer<typeof deploymentSchema>;
export type MarketName = "A_naive" | "B_conservative" | "C_afterbell";

const raw: Record<Network, unknown> = { testnet, mainnet };

/** Single source of addresses for every off-chain package. Written by contracts/script/Deploy.s.sol. */
export function getDeployment(network: Network): Deployment {
  return deploymentSchema.parse(raw[network]);
}
