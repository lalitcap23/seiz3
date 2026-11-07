# Seiz3 market feed (Chainlink CRE)

The vault needs two facts it can't read on-chain:

1. **Is the US stock market open?** Chainlink Data Streams' `marketStatus` for NVDA, or the exchange's regular hours (see below).
2. **How much can the xyz:NVDA book absorb?** HyperCore's precompiles give the oracle, not the book depth, and a partial hedge fill on a thin weekend book is Seiz3's main failure mode.

The contract has to trust both, so they come from a CRE workflow: every node fetches them on its own, and the DON signs only what the nodes agree on.

```
cron (1 min)
  ─► RiskParams.params()                     EVM read (HyperEVM): hedgeCapBps and oracleBandBps
  ─► Hyperliquid l2Book + metaAndAssetCtxs   node mode; bids within hedgeCapBps of the oracle × oracle; median
  ─► market status, by config `marketStatus`:
       "dataStreams"  Data Streams /api/v1/reports/latest, node mode, HMAC-signed; v8/v11 marketStatus, identical
       "marketHours"  the exchange's regular session at the DON's clock; times and holidays from the config
  ─► Chainlink Data Feed NVDA/USD            EVM read (Ethereum), optional: gap to HyperCore's oracle
  ─► DON-signed report ─► forwarder ─► RiskParams.onReport(open, hedgeCapacity, observedAt)
```

**Market hours (the testnet setting).** Our Data Streams key is authenticated but not yet authorized for the NVDA feed (`GET /api/v1/feeds` lists none), so `config.staging.json` sets `marketStatus: "marketHours"`: 09:30–16:00 New York time on weekdays, 13:00 on early-close days, closed on the listed NYSE holidays. New York's daylight-saving rule is in code (the runtime has no time-zone data); everything else is config. Switch back with `"marketStatus": "dataStreams"` once the feed is authorized.

**The Data Feed check.** Chainlink's free `NVDA-USD (24/5)` feed on Ethereum (`dataFeed.proxy`) is compared with HyperCore's oracle. If they differ by more than the vault's own `oracleBandBps` while the feed is fresh (`maxAgeSec`), and `enforce` is on, the report carries zero hedge capacity and the vault stops buying. A feed older than `maxAgeSec` (weekends) isn't compared. `enforce` is off on testnet: HyperCore's testnet oracle isn't the real NVDA price.

What reads it:

| Consumer | Reads | Effect |
| --- | --- | --- |
| `Seiz3Vault.liquidate` | `risk.get().maxLiquidation` | capped at the hedge capacity: the vault never buys more stock than HyperCore's book can hedge |
| `Seiz3Hook` | `risk.marketOpen()` | 0.3% fee / 0.1% spread while open, 1% / 1% after the bell |
| `Seiz3Vault.unwindStep` | `risk.cooldown()` | 10 s between unwind chunks while open, 300 s closed |
| keeper | `risk.get()`, `marketOpen()` | sizes liquidations to the same cap |

`RiskParams` ([contracts/src/RiskParams.sol](../../contracts/src/RiskParams.sol)) is the receiver, built on Chainlink's `ReceiverTemplate`:

- The report takes over from the owner's values at the first one.
- A report older than `maxReportAge` (300 s, five cron runs) fails closed: `maxLiquidation` 0 and after-hours pricing.
- Reports must arrive in observation order, and no more than 60 s ahead of the block.
- `setMaxReportAge(0)` turns the feed off; the owner's `setMarketOpen` and caps apply again.
- The forwarder is pinned. `setExpectedWorkflowId` / `setExpectedAuthor` pin the workflow too.

No vault bytecode changed: it already loads both values through `risk.get()` and `risk.marketOpen()`.

## Files

```
packages/cre/
├─ project.yaml              RPCs per target (hyperliquid-testnet / hyperliquid-mainnet)
├─ secrets.yaml              DATA_STREAMS_API_KEY / DATA_STREAMS_API_SECRET → env vars
├─ .env.example              copy to .env for the CLI (gitignored)
├─ market-feed/              the workflow: workflow.yaml, main.ts, config.{staging,production}.json
├─ src/workflow.ts           cron handler: reads → consensus → one signed write
├─ src/datastreams.ts        HMAC auth, v8/v11 report decoding
├─ src/marketHours.ts        regular session from the config's times and calendar
├─ src/dataFeed.ts           Chainlink Data Feed read + price check
├─ src/hyperliquid.ts        l2Book + oracle per node
├─ src/book.ts               capacity math, bigint only
├─ src/riskParams.ts         RiskParams read + report encoding/write
└─ test/workflow.test.ts     31 tests on the SDK's test runtime
```

## Run it

Offline, no keys. The tests run the real handler through the SDK test runtime: secrets, node-mode consensus, the HTTP and EVM capabilities and `writeReport`, with only the far ends mocked.

```bash
pnpm --filter @seiz3/cre test        # 31 tests
pnpm --filter @seiz3/cre typecheck
pnpm --filter @seiz3/cre compile     # the CLI's own build: cre-compile → dist/market-feed.wasm
```

With the CRE CLI against HyperEVM testnet, from the repo root. `CRE_PRIVATE_KEY` in `.env.local` pays for `--broadcast` (its own key, so it never races the bots for the deployer's nonce); Data Streams credentials (`DATA_STREAM_USERNAME`, `HMAC_SECRET`) only matter with `marketStatus: "dataStreams"`:

```bash
scripts/testnet-stack.sh cre                 # dry run
scripts/testnet-stack.sh cre --broadcast     # the report lands in RiskParams
scripts/testnet-stack.sh cre-loop            # a report every minute, as a DON would: keep it running for a demo
scripts/testnet-stack.sh cre-status          # the last report, its age, and what the vault reads from it
scripts/testnet-stack.sh cre-off             # nothing will report: the owner's values apply again (cre-on to undo)
```

First report: [`0xdc8546e8…c5a2cd`](https://app.hyperliquid-testnet.xyz/explorer/tx/0xdc8546e8c5a86200bed442f594a1473aeb3e4cc771e682bedb4501544cd5c2cd), which lowered the vault's liquidation cap from the owner's $50,000 to the book's $265.24.

Or by hand:

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash   # once
cre login                                                # once, opens the browser
cd packages/cre && cp .env.example .env                  # Data Streams key + secret; CRE_ETH_PRIVATE_KEY for --broadcast
cre workflow simulate market-feed --target staging-settings                 # dry run: the write is prepared, not sent
cre workflow simulate market-feed --target staging-settings --broadcast     # sends the report through the forwarder
```

`config.staging.json` points at the testnet RiskParams (`deployments/testnet.json`). On HyperEVM testnet that RiskParams trusts the **simulation** forwarder `0xB27fA1c28288c50542527F64BCda22C9FbAc24CB`, which is what `--broadcast` writes through. The production forwarders are `0x76c9cf54…` (testnet) and `0x9eF6468C…` (mainnet), for a workflow deployed to the DON; `DeployHelpers.creForwarder` picks mainnet's on chain 999.

Then check what landed:

```bash
cast call <riskParams> 'lastReport()(bool,uint64,uint128)' --rpc-url https://rpc.hyperliquid-testnet.xyz/evm
cast call <riskParams> 'get()((uint256,uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint8,uint32,uint32,uint32,uint256,uint16,uint8))' --rpc-url …
```

## Things to know

- **A simulated feed goes stale.** On testnet, nothing reruns the workflow every minute the way a DON would, so once `cre-loop` stops, `maxReportAge` passes and liquidations stop (by design). Keep `cre-loop` running, or `cre-off` to go back to the owner's values.
- **The entry calls `main()` bare.** `cre-compile` appends its own `main().catch(…)` unless it finds `main()` or `await main()`; `void main()` isn't recognised, so the handler ran twice and the second run failed the simulation.
- **A mined forwarder tx isn't a landed report.** The forwarder catches the receiver's revert (e.g. a report out of order), so the workflow also checks `receiverContractExecutionStatus`.
- **Anyone can call the simulation forwarder.** It doesn't check DON signatures. After the first `--broadcast`, pin the workflow with `setExpectedWorkflowId`, or `setExpectedAuthor` plus `setExpectedWorkflowName`. Production uses the real forwarder, which checks the DON's signatures.
- **The status must match on every node.** A run that lands on an open/close boundary can see nodes disagree; it fails, and the next minute's run reports.
- **Capacity is the visible book.** `l2Book` returns 20 levels a side. A band deeper than that is undercounted, which errs safe. `bookShareBps` (production 50%) leaves room for everyone else trading into the same bids.
- **`observedAt` is the older of the two reads**, so a fresh book can't make an old market status look fresh.
- **Data Streams is mainnet-only for these credentials**, whatever chain the report goes to: staging reads `api.dataengine.chain.link`. The key must be authorized for the feed (`GET /api/v1/feeds` lists what it can read); otherwise every run stops at `HTTP 401 feeds not authorized`.
- **The API sits behind Cloudflare**, which rejects some clients' default User-Agent (error 1010), so the request sends its own.
- **No `z.string().url()` in the config schema**: it needs the `URL` global, which the CRE runtime doesn't have, and every URL fails validation.
