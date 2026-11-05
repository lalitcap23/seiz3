import { z } from "zod";

export const env = z
  .object({
    NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    API_PORT: z.coerce.number().default(8787),
    HL_INFO_API_URL: z.string().url().optional(),
    REPLAY_TOKEN: z.string().default("change-me"),
  })
  .parse(process.env);
