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
    LOGS_RPC_URL: z.string().url().optional(), // eth_getLogs only; default RPC_URL (Alchemy's testnet has none)
    LOG_SCAN_MS: z.coerce.number().int().min(0).default(0), // gap between log scans; 3000 keeps a public RPC happy
    REPLAY_TOKEN: z.string().default("change-me"),
    // testnet faucet relay (POST /faucet): the key Faucet.setOperator allowed; unset → the route answers 503
    FAUCET_OPERATOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    FAUCET_IP_COOLDOWN_SEC: z.coerce.number().int().min(0).default(3600),
    // behind a proxy (Fly, Railway, nginx) the client IP is the first x-forwarded-for entry
    TRUST_PROXY: z.enum(["0", "1"]).default("0"),
    WATCH_FILE: z.string().optional(), // default deployments/watch.json: testers the keeper checks every tick
  })
  // compose passes unset optional keys as "": treat them as unset
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
