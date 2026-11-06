import { z } from "zod";

export const env = z
  .object({
    NETWORK: z.enum(["local", "testnet", "mainnet"]).default("testnet"),
    API_PORT: z.coerce.number().default(8787),
    RPC_URL: z.string().url().optional(), // default: anvil for local, HYPEREVM_(TESTNET_)RPC_URL or viem's
    DEPLOYMENTS_PATH: z.string().optional(), // default: deployments/<NETWORK>.json
    HL_INFO_API_URL: z.string().url().optional(), // unused on local: the panel reads MockHyperCore's precompiles
    POLL_MS: z.coerce.number().int().min(250).default(1000),
    FROM_BLOCK: z.coerce.bigint().optional(), // first block of the activity / bad-debt log scan
    REPLAY_TOKEN: z.string().default("change-me"),
  })
  .parse(process.env);
