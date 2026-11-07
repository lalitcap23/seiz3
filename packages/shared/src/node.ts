/** Node-only helpers (they read the filesystem), kept out of the main entry so the web bundle never imports them. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Address } from "viem";
import { deploymentSchema } from "./deployments.js";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as Address);

/** deployments/<network>.json as the scripts leave it: DeployRemote.s.sol, then CreateMarkets' markets, then borrowers. */
const deploymentFileSchema = deploymentSchema.extend({
  naiveLiquidator: address.optional(),
  poolSeeder: address.optional(),
  // public testers' faucet and swap router, market A's own thin pool
  faucet: address.optional(),
  swapRouter: address.optional(),
  thinPoolKey: deploymentSchema.shape.poolKey.optional(),
  startBlock: z.number().int().nonnegative().optional(), // where the markets were created: log scans start here
  markets: deploymentSchema.shape.markets.unwrap(),
  borrowers: z.array(z.object({ address, label: z.string().optional() })).default([]),
});

export type DeploymentFile = z.infer<typeof deploymentFileSchema>;

/** The repo's deployments/ directory. */
export const DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../deployments/", import.meta.url));

export function loadDeployment(network: string, path?: string): DeploymentFile {
  const file = path ?? `${DEPLOYMENTS_DIR}${network}.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${String(error)}`);
  }
  const parsed = deploymentFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file}: ${issues} (run DeployRemote.s.sol and CreateMarkets.s.sol first)`);
  }
  return parsed.data;
}
