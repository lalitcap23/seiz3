import { z } from "zod";
import { DEPLOYMENTS_DIR } from "@afterbell/shared/node";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const env = z
  .object({
    NETWORK: z.enum(["testnet", "mainnet", "base-sepolia"]).default("testnet"),
    RPC_URL: z.string().url().optional(),
    DEPLOYMENTS_PATH: z.string().optional(),
    /** oracle,pool,mm,alerts: which bots run in this process */
    BOTS: z.string().default("oracle,pool,mm,alerts"),
    /** Owns the DemoOracles, PoolSeeder and MockNVDAx: Deploy.s.sol's broadcaster. */
    DEPLOYER_PRIVATE_KEY: key.optional(),
    /** While this file exists the EVM bots stand still: a presenter crash sets the oracles on purpose. */
    HOLD_FILE: z.string().default(`${DEPLOYMENTS_DIR}BOTS_HOLD`),
    EVM_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),

    // oracle follower: markets A/B/C follow HyperCore's oracle (the vault refuses liquidations 1.5% away from it)
    FOLLOW_BPS: z.coerce.number().int().min(1).default(25),

    // pool rebalancer: the vault's pool back on HyperCore's oracle after testers' swaps and unwind chunks
    REBALANCE_BPS: z.coerce.number().int().min(1).default(30),
    MIN_REBALANCER_USDC: z.coerce.number().default(20), // warn under this: the next rebalance up may fail
    NVDAX_TOPUP: z.coerce.number().positive().default(5), // minted to the deployer when it runs low
    // testnet's only arbitrageur is this bot: unwind proceeds land in the vault, where the deployer is the main LP, so
    // it redeems USDC_TOPUP of its own shares when low, leaving the vault at least VAULT_FLOOR_USDC for liquidations
    USDC_TOPUP: z.coerce.number().positive().default(40),
    VAULT_FLOOR_USDC: z.coerce.number().min(0).default(100),

    // HyperCore market maker on xyz:NVDA: the counterparty for the vault's hedges and unwinds
    HL_MM_PRIVATE_KEY: key.optional(), // the account's key, or an API (agent) wallet it approved
    HL_MM_ACCOUNT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), // the account, when the key is an agent
    MM_SPREAD_BPS: z.coerce.number().int().min(1).max(90).default(40), // inside the vault's 100 bps IOC cap
    MM_SIZE: z.coerce.number().positive().default(0.5), // NVDA per side: at least the largest liquidation
    MM_MAX_POSITION: z.coerce.number().positive().default(1.5), // NVDA long from resting bids: the account runs at 20x
    MM_VAULT_MAX_SHORT: z.coerce.number().positive().default(4), // hard cap on the NVDA short it may sell the vault
    // the real limit: sell the vault only while HyperCore's liquidation price stays this far above the oracle
    MM_MIN_LIQ_DISTANCE: z.coerce.number().positive().max(1).default(0.08),
    // the keeper's request for an ask before an unwind (its liquidity gate), and what to add for the testnet bot
    // that lifts 0.056 NVDA of any ask near the oracle every ~3 s while the vault's order is on its way
    ASK_REQUEST_FILE: z.string().default(`${DEPLOYMENTS_DIR}ASK_REQUEST.json`),
    MM_ASK_BUFFER: z.coerce.number().min(0).default(0.12),
    MM_REQUOTE_BPS: z.coerce.number().int().min(1).default(15),
    MM_INTERVAL_MS: z.coerce.number().int().min(1000).default(3000), // under the info API's 1200 weight a minute

    // buyer (BOTS=…,buyer): a demo buyer that, while the vault unwinds, buys NVDAx through the hook every
    // BUYER_INTERVAL_MS. ≥ 12 USDC so the vault's buy-back of what it sells clears HyperCore's $10 order minimum.
    BUYER_USDC: z.coerce.number().min(12).default(20),
    BUYER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(90_000),
    BUYER_PUSH_BPS: z.coerce.number().int().min(1).max(100).default(5), // bid the curve this far past the hook's ask
    // buy only while the vault's unwind cooldown has this long left, so the keeper's next sale can't land between the
    // buyer's two transactions (a sale sets a pending buy-back, and the hook sells nothing until it's confirmed)
    BUYER_MIN_WINDOW_SEC: z.coerce.number().int().min(1).default(10),
    // buy once from every liquidation's stock right away, inside the keeper's BUYER_WINDOW_SEC (Base Sepolia demo)
    BUYER_EACH_LIQUIDATION: z
      .enum(["0", "1", "true", "false"])
      .default("0")
      .transform((v) => v === "1" || v === "true"),
    // util (BOTS=…,util): hold market C at its rate model's target utilization, leaving this much USDC free to borrow
    UTIL_FREE_USDC: z.coerce.number().positive().optional(),
    // pool rebalancer: while the vault holds stock, hold the pool this far over the hook's ask instead of the oracle
    POOL_ABOVE_ASK_BPS: z.coerce.number().int().min(1).max(50).optional(),

    // alerts: what only a person can refill on testnet (Discord or Slack incoming webhook; unset → log only)
    ALERT_WEBHOOK_URL: z.string().url().optional(),
    ALERT_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
    ALERT_IDLE_USDC: z.coerce.number().default(40), // ~2 testers' repayments
    ALERT_CORE_USDC: z.coerce.number().default(60),
    ALERT_MM_USDC: z.coerce.number().default(15), // free margin: ~1.5 NVDA of quotes at 20x
    ALERT_DEPLOYER_HYPE: z.coerce.number().default(0.01),
  })
  // compose passes unset optional keys as "": treat them as unset
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));

export const bots = new Set(env.BOTS.split(",").map((b) => b.trim()));
