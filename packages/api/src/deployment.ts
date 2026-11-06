import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Address } from "viem";
import { deploymentSchema } from "@afterbell/shared";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as Address);

/** deployments/<network>.json as the scripts leave it: Deploy.s.sol, then CreateMarkets' markets, then borrowers. */
const apiDeploymentSchema = deploymentSchema.extend({
  naiveLiquidator: address.optional(),
  markets: deploymentSchema.shape.markets.unwrap(),
  borrowers: z.array(z.object({ address, label: z.string().optional() })).default([]),
});

export type ApiDeployment = z.infer<typeof apiDeploymentSchema>;

export function loadDeployment(network: string, path?: string): ApiDeployment {
  const file = path ?? fileURLToPath(new URL(`../../../deployments/${network}.json`, import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${String(error)}`);
  }
  const parsed = apiDeploymentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file}: ${issues} (run Deploy.s.sol and CreateMarkets.s.sol first)`);
  }
  return parsed.data;
}
