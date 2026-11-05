import { z } from "zod";

export const env = z
  .object({
    NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    KEEPER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((s) => s as `0x${string}`),
    HL_INFO_API_URL: z.string().url().optional(),
    KEEPER_TICK_MS: z.coerce.number().default(1000),
  })
  .parse(process.env);
