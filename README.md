# Seiz3

A vault that buys seized stock collateral from Morpho, shorts the same stock on HyperCore in the same transaction, then sells the stock through Uniswap v4 while closing the short: buyers on the vault's pool are filled from its hedged stock by a v4 hook, and the keeper pushes whatever nobody buys. A Chainlink CRE workflow tells the contracts whether the stock market is open and how much HyperCore's book can hedge.

Live on Base Sepolia at [seiz3.xyz](https://seiz3.xyz) (API: [api.seiz3.xyz](https://api.seiz3.xyz)).

The full design is in [`Seiz3 system architecture.md`](Seiz3%20system%20architecture.md).

## Layout

```
seiz3/
├─ contracts/            Foundry (solc 0.8.28 for src/, cancun)
│  ├─ src/               Seiz3Vault, Seiz3Hook, RiskParams, libs/{HedgeLib,UnwindLib,Units},
│  │                     cre/ (Chainlink ReceiverTemplate), mocks/{MockNVDAx,DemoOracle,NaiveLiquidator,PoolSeeder}
│  ├─ script/            Deploy, CreateMarkets, SeedPool (+ DeployHelpers: risk defaults, pool key)
│  └─ test/              unit/ · integration/ (real Morpho + v4 bytecode, MockHyperCore, HookFill) ·
│                        sim/ (ring 2, hyper-evm-lib CoreSimulator) · fork/ (ring 3) · utils/
├─ packages/
│  ├─ shared/            wagmi-generated ABIs, deployments loader, Snapshot types, unit converters, HL info client
│  ├─ keeper/            Node + viem tick loop
│  ├─ api/               Hono: GET /snapshot, GET /stream (SSE), GET /history, POST /replay/:step
│  ├─ replay/            scripted 3-market demo, one step per click
│  ├─ cre/               Chainlink CRE workflow: market status + hedge capacity → RiskParams
│  └─ web/               Next.js 16 (App Router, Tailwind 4, TanStack Query, Recharts)
└─ deployments/          testnet.json / mainnet.json, written by Deploy.s.sol
```

All addresses and ABIs reach the off-chain code through one path: `forge build` + `Deploy.s.sol` → `deployments/*.json` + `contracts/out` → `@seiz3/shared`.

## Uniswap v4 hook (Seiz3Hook)

The vault's NVDAx/USDC pool carries [`Seiz3Hook`](contracts/src/Seiz3Hook.sol) with a dynamic fee. A buyer of NVDAx is filled from the vault's hedged inventory at the HyperCore oracle price plus a spread, off the curve, and each fill queues the matching reduce-only buy on HyperCore. Whatever the hook doesn't fill goes to the curve at a fee set by market hours.

| What | Where |
| --- | --- |
| Permissions: `beforeInitialize`, `beforeSwap`, `beforeSwapReturnDelta` | [`Seiz3Hook.sol:31`](contracts/src/Seiz3Hook.sol#L31) |
| The fill: price, size, settle, return the delta | [`beforeSwap` 192–217](contracts/src/Seiz3Hook.sol#L192-L217), [`_fill` 221–246](contracts/src/Seiz3Hook.sol#L221-L246) |
| What one buy can take, at what ask (also the dashboard's quote) | [`quote` 144–158](contracts/src/Seiz3Hook.sol#L144-L158), [`_capacity` 162–181](contracts/src/Seiz3Hook.sol#L162-L181) |
| The vault's side: send the stock, queue the buy-back | [`Seiz3Vault.onHookFill` 398–414](contracts/src/Seiz3Vault.sol#L398-L414) |
| Address mining and deploy order (hook → vault → `setVault`) | [`Deploy.s.sol` 59–77](contracts/script/Deploy.s.sol#L59-L77), [`_deployHook` 101–109](contracts/script/Deploy.s.sol#L101-L109), [`DeployHelpers.mineHookSalt` 67–87](contracts/script/DeployHelpers.sol#L67-L87) |
| Tests | [`HookFill.t.sol`](contracts/test/integration/HookFill.t.sol), hook buys in [`HedgeInvariant.t.sol`](contracts/test/integration/HedgeInvariant.t.sol), `test_sim_hookFill_buyBackLandsOnCore` (CoreSimulator), `test_hookFill_onTheDeployedPoolManager` (mainnet fork) |

Rules:

- **When it fills.** A fill happens under the same rules as `unwindStep`: no owner pause, no hedge in flight, and the short within `maxUnhedged` of −inventory. One fill is at most `maxUnhedged`, on whole Core size units.
- **When it passes.** The hook sells only when the pool trades at or above its ask, so a buyer never pays more than the curve's price. A fill sets the vault's pending hedge, so the next buyer goes to the curve until `syncHedge` confirms the buy-back.
- **Ask and fee.** Defaults (`setSettings`):
  - spread over the Core oracle: 0.10% while the market is open, 1% after the bell;
  - curve fee: 0.30% while open, 1% after the bell.
  - The vault's own `unwindStep` sells always pay the open fee.
- **Fails open.** If a HyperCore read fails, swaps still go through the curve at the closed fee, and nothing is sold from the vault.
- **Market A's own pool.** Market A dumps into its own hookless pool (`thinPoolKey`), so the vault's pool stays near the oracle.

Deploying needs the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`. It is on anvil, HyperEVM testnet and HyperEVM mainnet. Uniswap's hackathon feedback is in [FEEDBACK.md](FEEDBACK.md).

## Chainlink CRE workflow (market feed)

Two facts the vault needs but can't read on-chain come from a CRE workflow ([`packages/cre`](packages/cre)). First, is the US stock market open. Second, how much NVDA HyperCore's xyz book can absorb: bids within the vault's hedge band, from Hyperliquid's `l2Book`. Every node fetches the book; the DON takes the median and signs one report to `RiskParams`. The vault caps each liquidation at that capacity, and the hook prices from that status. Neither the vault nor the hook changed: they already read `risk.get()` and `risk.marketOpen()`.

The market status has two sources, picked by `marketStatus` in the workflow config. `dataStreams` reads Chainlink Data Streams' `marketStatus` for NVDA (every node must agree). `marketHours` computes the exchange's regular session from the DON's clock, with the session times and holiday calendar in the config. The testnet config uses `marketHours` until our Data Streams key is authorized for the NVDA feed; everything else is live data. The workflow also reads Chainlink's free **NVDA/USD Data Feed** on Ethereum and compares it with HyperCore's oracle: outside the vault's oracle band, the report carries zero capacity (enforced on mainnet; observed on testnet, where HyperCore's oracle isn't the real price).

First report on HyperEVM testnet, through the CRE CLI's simulation forwarder: [`0xdc8546e8…c5a2cd`](https://app.hyperliquid-testnet.xyz/explorer/tx/0xdc8546e8c5a86200bed442f594a1473aeb3e4cc771e682bedb4501544cd5c2cd) (decoded at `http://localhost:3000/tx/<hash>` while the API runs). `scripts/testnet-stack.sh cre-loop` keeps reporting every minute, as a DON would.

| What | Where |
| --- | --- |
| The workflow: EVM read → book consensus → market status → Data Feed check → signed write | [`workflow.ts` `onCronTrigger` 102–153](packages/cre/src/workflow.ts#L102-L153) |
| Market status source: Data Streams or market hours | [`workflow.ts` `readMarket` 86–100](packages/cre/src/workflow.ts#L86-L100), [`marketHours.ts` 29–52](packages/cre/src/marketHours.ts#L29-L52) |
| Data Streams: HMAC auth, v8/v11 `marketStatus` | [`datastreams.ts` 36–121](packages/cre/src/datastreams.ts#L36-L121) |
| Chainlink Data Feed price check | [`dataFeed.ts` 47–78](packages/cre/src/dataFeed.ts#L47-L78) |
| Hedge capacity from the book | [`hyperliquid.ts` `readHedgeCapacity` 54–69](packages/cre/src/hyperliquid.ts#L54-L69), [`book.ts` 37–45](packages/cre/src/book.ts#L37-L45) |
| The receiver: report → state, ordering, future guard | [`RiskParams._processReport` 104–111](contracts/src/RiskParams.sol#L104-L111) |
| The vault's cap: `maxLiquidation` lowered to the capacity, 0 once stale | [`RiskParams.get` 65–72](contracts/src/RiskParams.sol#L65-L72), [`_report` 114–119](contracts/src/RiskParams.sol#L114-L119) |
| The hook's fee and the unwind cooldown | [`RiskParams.marketOpen` 80–83](contracts/src/RiskParams.sol#L80-L83) |
| Forwarder per chain | [`DeployHelpers.creForwarder`](contracts/script/DeployHelpers.sol#L43) |
| Tests | [`workflow.test.ts`](packages/cre/test/workflow.test.ts) (SDK test runtime), [`RiskParams.t.sol`](contracts/test/unit/RiskParams.t.sol), `test_liquidate_cappedByTheCreHedgeCapacity`, `test_fee_followsTheCreMarketStatus`, keeper scenarios "sizes the liquidation to the Chainlink CRE hedge capacity" / "stops liquidating once the CRE report is stale" |

A report older than `maxReportAge` (300 s) fails closed: no liquidations, and after-hours pricing. `setMaxReportAge(0)` hands control back to the owner's values. How to simulate it with the CRE CLI is in [packages/cre/README.md](packages/cre/README.md).

## Setup

```bash
git submodule update --init --recursive   # Solidity libs
pnpm install
cp .env.example .env                      # fill keys + addresses after spikes
pnpm codegen                              # forge build + wagmi ABIs → packages/shared/src/generated
```

## Common commands

| Command                                                         | What it does                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm contracts:test`                                           | Unit + integration tests, offline: real Morpho Blue and v4 PoolManager deployed locally, MockHyperCore |
| `pnpm contracts:test:sim`                                       | CoreSimulator tests (forks HyperEVM mainnet, real USDC + CoreDepositWallet)                         |
| `pnpm contracts:test:fork`                                      | Deployed Morpho + v4 on a fork (`MORPHO_ADDRESS`, `MORPHO_IRM_ADDRESS`, `POOL_MANAGER_ADDRESS`); skips until set |
| `pnpm codegen`                                                  | Rebuild contracts and regenerate TS ABIs                                                            |
| `pnpm typecheck`                                                | Typecheck every package                                                                             |
| `pnpm dev`                                                      | API + web together                                                                                  |
| `pnpm web`                                                      | Dashboard only; set `NEXT_PUBLIC_USE_FIXTURE=1` in `packages/web/.env.local` to run without the API |
| `pnpm keeper`                                                   | Keeper bot                                                                                          |
| `pnpm test` / `pnpm test:scenarios`                             | Keeper unit tests / keeper against the real contracts on the local stack (below)                    |
| `pnpm --filter @seiz3/cre test` / `compile`                 | CRE workflow on the SDK's test runtime / build its WASM with `cre-compile`                          |
| `pnpm replay <setup\|reset\|scene\|marketA\|marketB\|marketC\|buyers\|monday>` | One demo step (see "Demo replay")                                              |

## Deploying

The vault is too big for a 3M-gas fast block. Switch the deployer to big blocks first, and switch it back afterwards:

```bash
# big blocks on (see Hyperliquid docs: evmUserModify usingBigBlocks=true)
cd contracts
# 0. testnet only: our own Morpho Blue + v4 PoolManager (mainnet has the real ones, see .env.example);
#    writes deployments/testnet-infra.json → MORPHO_ADDRESS, MORPHO_IRM_ADDRESS, POOL_MANAGER_ADDRESS
forge script script/TestnetInfra.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
# 1. MockNVDAx, RiskParams, vault, NaiveLiquidator, PoolSeeder; seed deposit
#    testnet xyz:NVDA: PERP_DEX_INDEX=65 PERP_ASSET=750002 (mainnet: 1 / 110002)
NETWORK=testnet forge script script/Deploy.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
# 2. three demo markets (one DemoOracle each), market C allow-listed on the vault; merges `markets` into the json
NETWORK=testnet forge script script/CreateMarkets.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
# 3. thin weekend pool; run again with THIN=false for the "Monday" liquidity
NETWORK=testnet THIN=true forge script script/SeedPool.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
```

`Deploy.s.sol` writes `deployments/<NETWORK>.json`; `CreateMarkets.s.sol` merges the `markets` block into it.

### After deploy: fund the hedge account

A new HyperCore account must exist before it sends actions, so margin goes on in later blocks. These calls read the HyperCore precompiles, which `forge script`'s local EVM doesn't have, so use `cast` (it runs against the node).

**Mainnet.** Deploy.s.sol's activation deposit creates the vault's account (1 USDC fee, `accountActivationGas` in the ledger):

```bash
# true once the activation deposit has landed (read precompile 0x…0810)
cast call 0x0000000000000000000000000000000000000810 $(cast abi-encode "f(address)" $VAULT) --rpc-url $RPC
# top up via spot + sendAsset: both halves are proven, a direct deposit to xyz isn't (spike 2b)
cast send $VAULT "setMarginDepositDex(uint32)" 4294967295 --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY
cast send $VAULT "sweepSpotToDex()" --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY      # activation leftover → xyz
cast send $VAULT "topUpMargin(uint256)" 20000000000 --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY  # 20k USDC
```

**Testnet.** Its CoreDepositWallet takes the USDC and never credits HyperCore, for new and existing accounts alike (spike 2a/2b: 31 USDC lost). Nothing there may go through it, so not `activateCore` and not `topUpMargin`. Fund the vault from the HyperCore side:

1. On app.hyperliquid-testnet.xyz, **Send USDC (spot) to the vault's address**, enough for all the margin the demo needs. The first send creates the account (the sender pays the 1 USDC fee).
2. Once `coreUserExists` (above) is true, `cast send $VAULT "sweepSpotToDex()"` moves it to xyz (CoreWriter `sendAsset`, ~26 blocks on testnet).

Keep that margin above `marginTarget()`: if the keeper sees a shortfall it calls `topUpMargin`, and on testnet that USDC is lost.

The keeper reads the same `deployments/<NETWORK>.json` (`DEPLOYMENTS_PATH`) and works market C. Morpho can't list a market's borrowers, so add the ones to watch as `"borrowers": [{ "address": "0x…", "label": "…" }]`.

## Local end to end (keeper ↔ contracts)

`scripts/local-stack.sh` puts the whole system on a local anvil: real Morpho Blue and Uniswap v4 bytecode, the deploy scripts above, and MockHyperCore copied over the HyperCore precompiles and CoreWriter with `anvil_setCode` (the `vm.etch` trick from the forge tests). HyperCore only acts when `MockHyperCore.processBlock()` is called.

```bash
anvil                                              # 1
scripts/local-stack.sh up                          # 2: deploy + fund → deployments/local.json (~40 s)
pnpm --filter @seiz3/keeper risk-engine:stub   # 3
pnpm test:scenarios                                # 4: keeper scenarios, each from the same anvil snapshot

# or watch the real keeper binary instead of 4:
scripts/local-stack.sh tick                        # HyperCore processes a block every second
scripts/local-stack.sh keeper
scripts/local-stack.sh price 205                   # the market C borrower goes under water: liquidate → hedge
scripts/local-stack.sh price 217                   # "Monday": unwind in 10 NVDA chunks
```

Locally nothing arbitrages the pool, so after a few chunks its price sags more than `maxSlippageBps` under the Core oracle and the vault refuses further unwinds (`Slippage`); the keeper skips them and the position stays hedged. Don't run `tick` during `test:scenarios`.

## Demo replay (the three-market show)

`pnpm replay <step>` plays the demo one click at a time, the same way every run; the API runs the same steps for a clicker at `POST /replay/:step` (header `authorization: Bearer $REPLAY_TOKEN`).

```bash
anvil
pnpm replay setup                                  # = scripts/local-stack.sh demo (~45 s)
scripts/local-stack.sh tick                        # own terminals, as for the local stack
pnpm --filter @seiz3/keeper risk-engine:stub
scripts/local-stack.sh keeper
NETWORK=local pnpm api

pnpm replay scene      # all three oracles (and HyperCore) to $205: A and C under water, B still healthy
pnpm replay marketA    # NaiveLiquidator dumps into the thin pool: ~$14.6k bad debt
pnpm replay marketB    # nothing to liquidate
pnpm replay marketC    # releases the keeper: liquidate → short → syncHedge, hedge ratio 0% → 100%
pnpm replay buyers     # weekend buyers fill from the vault through the v4 hook at its ask; each buy-back synced
pnpm replay monday     # arbitrage back to the oracle, deep pool, market open: the keeper unwinds to zero
pnpm replay reset      # rewind anvil to setup's snapshot for the next run
```

On stage, run the steps from the dashboard instead: `pnpm web`, then open `http://localhost:3000/?presenter=change-me` (the API's `REPLAY_TOKEN`). The presenter bar along the bottom runs each step through `POST /replay/:step`; → or space runs the next one. Without `?presenter=` the page is the plain dashboard: weekend/Monday status and pool vs HyperCore price, the three markets, the hedge ratio with stock held / short confirmed / short on HyperCore, the Hyperliquid position and the vault's activity feed.

The keeper sits out the scene and market A on its kill switch (`deployments/KILL`, created by `setup`, `reset` and `scene`, removed by `marketC`), so market C liquidates on its own click. `setup` seeds the vault with 1,000 USDC rather than 10, so the 1 USDC HyperCore activation fee doesn't show on the share price. Market A dumps into its own thin pool, and its dump empties that pool's range. The vault's hooked pool keeps Friday's $217 through the weekend. That is above the hook's after-hours ask ($205 oracle + 1%), so `buyers` fills straight from the vault. `monday` puts both pools back on the oracle with `PoolSeeder.swapToPrice`, then deep liquidity goes in around it. The risk-engine stub keeps whatever mode a test left it in: if `marketC` sits at `forced-idle` after `pnpm test:scenarios`, clear it with `curl -X DELETE localhost:8081/control`.

## Testnet end to end (keeper ↔ contracts ↔ real HyperCore)

`scripts/testnet-stack.sh` runs the same flow on HyperEVM testnet, scaled to a 1 NVDAx liquidation (~650 testnet USDC in all). Keys come from `.env.local` (`DEPLOYER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, and `HL_FUNDER_PRIVATE_KEY` for `fund-core`: the HyperCore wallet holding the USDC, not an API wallet). Big blocks and `fund-core` go through `@nktkas/hyperliquid` ([`packages/bots/src/hlAdmin.ts`](packages/bots/src/hlAdmin.ts)).

```bash
scripts/testnet-stack.sh big-blocks on   # the vault and PoolManager only fit in 30M-gas blocks
scripts/testnet-stack.sh infra           # our own Morpho + IRM + v4 PoolManager (testnet has neither)
scripts/testnet-stack.sh deploy
scripts/testnet-stack.sh big-blocks off
scripts/testnet-stack.sh markets         # priced at HyperCore's live NVDA oracle
scripts/testnet-stack.sh actors          # LP deposit, lender, borrower at 76.8% LTV, coreFunded flag (costs 1 USDC)
scripts/testnet-stack.sh fund-core       # 120 USDC (spot) to the vault on HyperCore (or Send it in the app)
# post a bid ≥ 1 NVDA on xyz:NVDA near the oracle (the bots' market maker does)
scripts/testnet-stack.sh sweep           # spot → xyz margin
pnpm --filter @seiz3/keeper risk-engine:stub   # own terminal
scripts/testnet-stack.sh keeper                    # own terminal
scripts/testnet-stack.sh crash           # market C 1.4% under HyperCore's oracle → liquidate → hedge
scripts/testnet-stack.sh status
```

HyperCore's oracle can't be moved on testnet, so market C's price follows it and `crash` stays inside the vault's 1.5% oracle band. The keeper runs with top-ups switched off (testnet's CoreDepositWallet would lose the USDC) and without Morpho's API (it doesn't index our Morpho copy).

### Demo round on the deployed testnet stack

With the stack up (`pnpm testnet:up`: keeper, risk engine, API, bots, web on http://localhost:3000), each round is live HyperEVM + HyperCore state; only the market status comes from market hours (see the CRE section):

```bash
scripts/testnet-stack.sh cre-loop          # own terminal: a Chainlink CRE report every minute, kept running all demo
scripts/testnet-stack.sh borrow 0.9        # a borrower just under market C's 77% LLTV at HyperCore's price
scripts/testnet-stack.sh crash             # market C 1.4% down → the keeper liquidates and shorts on HyperCore
scripts/testnet-stack.sh release           # market C back on HyperCore's price
scripts/testnet-stack.sh status            # inventory vs short, while the stock leaves the vault both ways (below)
scripts/testnet-stack.sh hook-fill 20      # optional: one more buyer filled by the hook, on demand
scripts/testnet-stack.sh cre-status        # the CRE report the vault and hook are reading
```

After a liquidation the stock leaves the vault two ways at once, both on the vault's Uniswap v4 pool:

- **Vault → AMM:** the keeper's `unwindStep` sells a chunk into the curve every cooldown (`Unwound`); the hook only sets the fee.
- **Vault → buyer:** the bots' `buyer` (`BOTS=…,buyer`, `BUYER_USDC` every `BUYER_INTERVAL_MS`) plays organic demand. It bids the curve just past the hook's ask, then buys through the public swap router, and Seiz3Hook fills it straight from the vault's stock at HyperCore's oracle plus the spread (`InventoryFill`), off the curve.

Each sale queues a reduce-only buy-back on HyperCore, filled against the market maker's standing ask.

`borrow` is bounded by what market C can lend (`fund-vault <usdc>` tops up the vault's idle USDC, which repays each liquidation). The bots keep the v4 pool on HyperCore's oracle (unwinds stay inside the 1% slippage check) and post the asks the buy-backs fill against; during a crash only market C's oracle follower holds. Rounds run on 2026-11-06:

| Step | Transaction |
| --- | --- |
| CRE report lands in RiskParams (liquidation cap → the book's $265.24) | `0xdc8546e8c5a86200bed442f594a1473aeb3e4cc771e682bedb4501544cd5c2cd` |
| Keeper liquidates the market C borrower, vault shorts 1.162 NVDA on HyperCore | `0x086c948f53688b62f27f0a424563805d2c29d42c8a5389dd51a7b761539c7e99` |
| Hook fill: 0.093 NVDAx from the vault for 19.99 USDC at the $214.9987 ask | `0x59cc48091f4db99b9f8398d75d8b773dd7cd2815f975d729de8ed39afa319d71` |

Open any of them decoded at `http://localhost:3000/tx/<hash>` (HyperEVM testnet has no working public explorer).

What keeps a round clean on testnet (found by auditing the vault's HyperCore order history, `historicalOrders`):

- **Every buy-back clears HyperCore's $10 minimum.** An unwind chunk stops at `maxImpactBps` of pool price impact; on the thin testnet pool 50 bps sold ~$4.75, so most buy-backs came back `minTradeNtlRejected`. Testnet runs `scripts/testnet-stack.sh risk-set maxImpactBps 120 maxSlippageBps 150` (~0.054 NVDAx ≈ $11.4 a chunk).
- **The market maker never leaves the vault without an ask.** While the vault holds stock it keeps an ask for min(stock, `maxUnhedged`) from the chain (a hook fill sends its buy-back with no warning), keeps any ask that still covers the next buy instead of churning it, and places a replacement before cancelling. Its bid (`MM_SIZE`, 1 NVDA) rests at full size: it is what a liquidation's hedge sells into, so it sets the CRE hedge capacity.
- **The keeper never withdraws margin on testnet** (`CORE_RESERVE_USDC`): `withdrawMargin` only reaches the vault's HyperCore spot balance there, out of the xyz margin the next short needs (`sweep` moves it back).
- **The keeper's breaker retries after a minute** (`BREAKER_COOLDOWN_MS`): RPC timeouts count as failed sends, and without it three in a row stopped the keeper until a restart.
- `faucet-cooldown <seconds>` sets how often one address may drip (600 for testing).

Two consecutive rounds after these changes: 17 of 17 HyperCore orders filled on the first try (the hedge, every buy-back, the hook fill's buy-back), vault flat at the end, no keeper failures.

## Base Sepolia (vault on Base, short on HyperCore)

Uniswap v4 isn't deployed on HyperEVM testnet, so this variant runs the vault where Morpho and Uniswap both have their own deployments: Base Sepolia. Morpho Blue `0xBBBB…FFCb` (no IRM, 77% and 38.5% LLTVs enabled) and the v4 PoolManager `0x05E7…3408` are theirs; nothing of either is redeployed. The short stays on HyperCore testnet (xyz:NVDA), in a hedge account the relayer controls. The HyperEVM contracts, scripts and stacks above are untouched; everything for Base is new and lives beside them.

```
Base Sepolia                                              HyperCore testnet
Morpho (theirs) ─liquidate─► Seiz3VaultRemote ─placeOrder─► HyperCoreGateway ─► relayer ─IOC─► hedge account (short)
Uniswap v4 (theirs) ◄─ Seiz3HookRemote ─┘   ▲                     ▲   ◄── snapshot + ack ──┘          │
                                                └─ reads (precompile   └── Chainlink CRE: DON-signed snapshot ◄┘
                                                   shapes) ─────────        of the hedge account, + RiskParams
```

| Piece | What it is |
| --- | --- |
| [`HyperCoreGateway`](contracts/src/remote/HyperCoreGateway.sol) | HyperCore's precompiles + CoreWriter for a chain without them: stores the vault's orders for the relayer, serves the precompile reads from the last snapshot (newer of relayer / CRE wins; older than `maxStateAge` → reads revert, the vault fails closed), and `settled()` once every order is acknowledged |
| [`Seiz3VaultRemote`](contracts/src/remote/Seiz3VaultRemote.sol) | Seiz3Vault with every HyperCore call through the gateway. Same ABI (`AbiParity.t.sol`), so the keeper, API and scripts drive it unchanged. `syncHedge` waits for `settled()`; margin moves revert `NoBridge` (fund the hedge account on HyperCore) |
| [`Seiz3HookRemote`](contracts/src/remote/Seiz3HookRemote.sol) | Seiz3Hook with its two HyperCore reads through the gateway; same flags, events and quote |
| [`packages/relayer`](packages/relayer) | Places each gateway order on HyperCore from the hedge account (vault's cloid; never twice), posts the account back with the acknowledgement, heartbeats in between. `BACKEND=hyperliquid` or `mock` (MockHyperCore on anvil) |
| CRE ([`src/gateway.ts`](packages/cre/src/gateway.ts), `base-feed/`) | The same market feed to RiskParams on Base, plus every node's own read of the hedge account → one DON-signed snapshot to the gateway |

`scripts/base-stack.sh local|fork|sepolia <command>` runs it (header has the full list):

- **local**: plain anvil on :8546, Morpho/v4 bytecode set up like Base Sepolia's, MockHyperCore behind the relayer. `up`, `relayer`, `activate`, `keeper`, then `round`: weekend → borrow → crash → liquidate → relayed short → hook fill → relayed buy-back → Monday unwind → flat, each step checked.
- **fork**: anvil forking Base Sepolia on :8547 (`anvil --fork-url https://sepolia.base.org --port 8547`): the same, against Morpho's and Uniswap's real deployments and Chainlink's real CRE forwarder (`cre --broadcast` lands both reports).
- **sepolia**: `infra`, `deploy`, `markets`, `seed deep|thin`, `actors`, fund the hedge account on HyperCore + `to-xyz`, `relayer`, `activate`, `keeper`, `bots`, `cre-loop`, then `crash` / `hook-fill` / `status`.

**Try it yourself on Base Sepolia.** `pnpm base:up` runs every service in docker (`docker-compose.base.yml`: risk engine, relayer, keeper, bots, the Chainlink CRE loop every minute, API on :8788, web on :3001; `pnpm base:logs [service]`, `pnpm base:ps`; `pnpm base:down` also takes the market maker's quotes off HyperCore). Each container runs `scripts/base-stack.sh sepolia <service>` with keys from `.env.local`; the CRE container uses the host's `cre login` (`~/.cre`). Without docker, `scripts/base-stack.sh sepolia live` starts the same services in one terminal (logs in `deployments/base-logs/`; Ctrl-C stops all). Run one or the other, never both: two relayers place every HyperCore order twice. Then open `http://localhost:3001/try` with a wallet on Base Sepolia:

1. **Get test tokens**: the faucet sends 1 NVDAx, 500 USDC and gas (the API pays the gas, so a new wallet works).
2. **Lend USDC** on Morpho market C.
3. **Deposit NVDAx** and **borrow Max**: right at the 77% LLTV. Market C runs on Morpho's AdaptiveCurveIrm at ~90% utilization (the bots' `util`), so interest tips it over ~15 s after the borrow lands; the Borrow card counts it down. To keep a loan open, borrow less than Max.
4. **Get liquidated** live: the keeper liquidates you, the vault holds your NVDAx, and the relayer shorts it on HyperCore.
5. **Watch it unwind** on the dashboard (`http://localhost:3001`): first to a buyer through the v4 hook at its ask, then into the pool, each sale bought back on HyperCore. Every liquidation sells to a buyer through the hook: the keeper waits up to 60 s for one (`BUYER_WINDOW_SEC`), the bots' buyer takes the first fill, and the pool sits just over the hook's ask while the vault holds stock (`POOL_ABOVE_ASK_BPS`), so you can also buy from the vault on the Swap card yourself.

The hedge account's 115 USDC of HyperCore margin covers about 1.3 NVDA of short at the vault's 3× margin check: one faucet drip per liquidation fits; bigger positions need more margin on `0x6011…40cB` (send USDC on HyperCore, then `to-xyz`).

**Live on Base Sepolia** (`deployments/base-sepolia.json`): vault [`0x9557…6c20`](https://sepolia.basescan.org/address/0x9557cd78f2332fb661eBd0017eE057cD4A086c20), hook `0x4fbe…2088`, gateway `0x6db0…d826`, RiskParams `0xce19…0990`, on Morpho `0xBBBB…FFCb` and PoolManager `0x05E7…3408`. Hedge account on HyperCore testnet `0x6011…40cB`. One full round on 2026-11-07:

| Step | Where | Transaction |
| --- | --- | --- |
| LP deposit 100 USDC | Base Sepolia | `0x066fab58…9882` |
| Borrow to 76.8% LTV, market C 1.4% under HyperCore | Base Sepolia | `scripts/base-stack.sh sepolia borrow` / `crash` |
| Keeper liquidates 1.054 NVDAx | Base Sepolia | `0xe14f8062…5bc9` |
| Relayer opens the short, 1.054 @ $212.23 (vault's cloid `0x6863…936f`) | HyperCore testnet | `0x64d435dd…e017` |
| `syncHedge` confirms −1054 through the gateway | Base Sepolia | `0x2a6bf640…5138` |
| 3 unwind chunks into Uniswap v4, each bought back on HyperCore (0.5 + 0.5 + 0.054 @ $213.51) | both | `0x624cf9fb…`, `0x32e4a03f…`, `0x526f57c6…` |
| Vault flat; CRE reports every minute (Data Streams status 2, equity book, HyperCore depth, hedge attestation) | Base Sepolia | via forwarder `0x8230…f3e5` |

Tests: `test/remote/` (gateway, the whole round with MockHyperCore behind a test relayer and nothing at the precompile addresses, ABI parity) and `test/fork/BaseSepoliaFork.t.sol` (the same round on Base Sepolia's own Morpho + PoolManager: `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org pnpm contracts:test:fork`). CRE reads RiskParams at the last *finalized* block, so on Base Sepolia the first report lands ~20 min after deploy.

## API (dashboard data)

`packages/api` reads everything the dashboard shows once a second and serves it as `GET /snapshot`, `GET /stream` (SSE) and `GET /history`:

- **HyperEVM, in one Multicall3 `eth_call`:** the three Morpho markets and their borrowers, the vault, RiskParams' market-open flag, the v4 pool's `slot0`, and the HyperCore precompiles (vault position, xyz margin, mark and oracle price).
- **Hyperliquid's info API:** `clearinghouseState` (dex `xyz`) for the vault. On the local stack the panel comes from MockHyperCore's precompiles instead.
- **Logs:** vault events and the hook's `InventoryFill` for the activity feed; Morpho's `Liquidate.badDebtAssets` and NaiveLiquidator's `Shortfall` for each market's bad debt. An unwind with an `InventoryFill` in the same transaction is `soldTo: "buyer"`, otherwise `"pool"`.
- **Hook:** `Seiz3Hook.quote()` (ask, what one buy can take, the fee now) as the snapshot's `hook` block.

Each market's borrower comes from the deployment file's `borrowers` (`label` = market name).

```bash
NETWORK=local pnpm api                          # after scripts/local-stack.sh up, which also puts Multicall3 on anvil
scripts/check-api.sh deployments/local.json     # every snapshot value against cast call at the same block
NETWORK=testnet pnpm api                        # optional: RPC_URL, FROM_BLOCK (log scan start), POLL_MS
```

`/snapshot` answers 503 until the first poll lands. The hedge ratio is the confirmed short over the vault's own target (inventory in Core size units), so it reads exactly 100% when hedged and 0% while a hedge is in flight. The public testnet RPC rate-limits `eth_getLogs` hard (999-block ranges are always refused, 500 pass), so the scan pages at 500 blocks, and a failed scan only delays the feed. Use a private RPC for the testnet and mainnet demos.

## Keeper notes

- **ABIs come from the contracts.** Every call goes through the wagmi-generated ABIs in `@seiz3/shared/abis`, so a renamed function or changed argument list is a type error. Run `pnpm codegen` after changing a contract.
- **It mirrors the vault's rules, the contract decides.** Pauses, cooldowns and Morpho's liquidation maths (seize no more than the debt and idle USDC can repay) are checked before simulating; an `eth_call` that reverts anyway (pool or lending oracle out of band, low Core margin) is skipped and logged with its error name, not sent and not counted by the breaker.
- **Block clock.** Order delays and cooldowns are compared against the latest block's timestamp, the clock the vault uses.
- **Margin.** It tops up the vault's `marginShortfall()` plus 10%, syncs to clear a margin pause once the shortfall is gone, and only sends back Core USDC above `marginTarget()` (enough for the next max-size liquidation).

## Contract notes

- **Two ids for one perp.** Orders take the asset id (`110002` for xyz:NVDA); position / oracle reads take the perp index (`10002`). The vault derives the second from the first.
- **Pausing is three flags.** `PAUSE_HEDGE` (hedge unconfirmed after `maxTries`) and `PAUSE_MARGIN` clear themselves on a good `syncHedge`; `PAUSE_OWNER` only clears on `unpause`. Paused stops liquidations and deposits. `unwindStep` still runs under `PAUSE_MARGIN`, which is how a margin-starved vault raises cash, but never under an owner pause or with a hedge in flight.
- **Only allow-listed markets.** Anyone can create a Morpho market with any oracle, so `liquidate` only accepts markets the owner allow-listed (the deploy flow lists market C).
- **Unwind pricing.** Each chunk's swap stops at a `maxImpactBps` price limit, and `minOut` is checked against the Core oracle, the price the short is bought back at.
- **In transit.** A deposit to Core is counted for `transitBlocks` blocks (default 1), then the precompile reads take over. Core → EVM needs no entry. On testnet neither direction of the USDC bridge credits: `withdrawMargin` leaves the USDC on the vault's HyperCore spot balance.
- **CRE report.** `RiskParams` is the CRE receiver (`ReceiverTemplate`, forwarder pinned). The vault reads its cap and market flag through `risk.get()` / `risk.marketOpen()`, so the CRE feed cost the vault no bytecode.
- **Code size.** `UnwindLib` is a linked library to keep the vault under 24 KB; forge links it in scripts and tests. With `onHookFill` the vault is 24,554 bytes, 22 under the limit: put new logic in the hook or a lens contract, or lower `optimizer_runs`.
- **Dust counts as flat.** Hook fills sell whole Core size units, so less than one unit of stock can be left behind. `syncHedge` treats that dust as no stock and closes the short fully, as the keeper already assumes.

## Status

Contracts, scripts and tests follow the architecture doc. The offline suite (unit, integration, invariant, scripts) and the CoreSimulator ring pass. The keeper runs against the deployed contracts on the local stack (liquidate → hedge → retry/pause → unwind → margin moves). Spikes still to run before kickoff:

- [x] HIP-3 position read on testnet: `position2` at perp index 650002 and `accountMarginSummary(65, user)` match the info API for live traders. On testnet xyz is DEX 65 (asset 750002), not 1
- [x] Margin path to `xyz`: CoreWriter `sendAsset` spot → xyz works (testnet, 26 blocks). The direct CoreDepositWallet deposit to xyz can't be tested on testnet (below), so mainnet uses spot + `sendAsset`
- [x] Account activation: mainnet CoreDepositWallet deposits create the account (1 USDC fee). Testnet's CoreDepositWallet never credits HyperCore at all, so testnet is funded with HyperCore-side sends (see "After deploy")
- [ ] Order delay → `RiskParams.orderDelaySec`; deposit visibility → `RiskParams.transitBlocks`
- [ ] Leverage on xyz: CoreWriter can't set it. If the default is wrong, `addApiWallet` lets an agent set it
- [x] Morpho on HyperEVM mainnet: `0x68e37dE8…` with 77% and 38.5% LLTVs and the AdaptiveCurve IRM `0xD4a426F0…` enabled. Not on testnet → `TestnetInfra.s.sol`
- [x] Uniswap v4 PoolManager on HyperEVM mainnet: `0x12D4Fd9C…`. Not on testnet → same. `pnpm contracts:test:fork` passes against both
- [x] Seiz3Hook on HyperEVM testnet: mined at `0x5Bf6…6088` (flags `0x2088`), pool initialised, a live buy paid its after-hours fee (1%), and a live buyer was filled from the vault's stock at the ask (`hook-fill`, tx in "Demo round")
- [x] CRE: `hyperliquid-testnet` / `hyperliquid-mainnet` are in the SDK's chain registry; the workflow compiles to WASM with `cre-compile`; the simulation forwarder `0xB27f…24CB` is on HyperEVM testnet
- [x] CRE CLI simulation with `--broadcast` on HyperEVM testnet: the report lands in RiskParams (market status from market hours, book depth from Hyperliquid, Chainlink Data Feed observed)
- [ ] Data Streams `marketStatus` instead of market hours: waiting on Chainlink to authorize our key for the NVDA feed (`marketStatus: "dataStreams"` in the config)
