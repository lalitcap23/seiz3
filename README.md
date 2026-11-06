# Afterbell

A vault that buys seized stock collateral from Morpho, shorts the same stock on HyperCore in the same transaction, then sells the stock through Uniswap v4 while closing the short: buyers on the vault's pool are filled from its hedged stock by a v4 hook, and the keeper pushes whatever nobody buys. A Chainlink CRE workflow tells the contracts whether the stock market is open and how much HyperCore's book can hedge.

The full design is in `../Afterbell system architecture.md`.

## Layout

```
afterbell/
├─ contracts/            Foundry (solc 0.8.28 for src/, cancun)
│  ├─ src/               AfterbellVault, AfterbellHook, RiskParams, libs/{HedgeLib,UnwindLib,Units},
│  │                     cre/ (Chainlink ReceiverTemplate), mocks/{MockNVDAx,DemoOracle,NaiveLiquidator,PoolSeeder}
│  ├─ script/            Deploy, CreateMarkets, SeedPool (+ DeployHelpers: risk defaults, pool key)
│  └─ test/              unit/ · integration/ (real Morpho + v4 bytecode, MockHyperCore, HookFill) ·
│                        sim/ (ring 2, hyper-evm-lib CoreSimulator) · fork/ (ring 3) · utils/
├─ packages/
│  ├─ shared/            wagmi-generated ABIs, deployments loader, Snapshot types, unit converters, HL info client
│  ├─ keeper/            Node + viem tick loop (`--replay` for the demo)
│  ├─ api/               Hono: GET /snapshot, GET /stream (SSE), GET /history, POST /replay/:step
│  ├─ replay/            scripted 3-market demo, one step per click
│  ├─ cre/               Chainlink CRE workflow: market status + hedge capacity → RiskParams
│  └─ web/               Next.js 16 (App Router, Tailwind 4, TanStack Query, Recharts)
└─ deployments/          testnet.json / mainnet.json, written by Deploy.s.sol
```

All addresses and ABIs reach the off-chain code through one path: `forge build` + `Deploy.s.sol` → `deployments/*.json` + `contracts/out` → `@afterbell/shared`.

## Uniswap v4 hook (AfterbellHook)

The vault's NVDAx/USDC pool carries [`AfterbellHook`](contracts/src/AfterbellHook.sol) with a dynamic fee. A buyer of NVDAx is filled from the vault's hedged inventory at the HyperCore oracle price plus a spread, off the curve, and each fill queues the matching reduce-only buy on HyperCore. Whatever the hook doesn't fill goes to the curve at a fee set by market hours.

| What | Where |
| --- | --- |
| Permissions: `beforeInitialize`, `beforeSwap`, `beforeSwapReturnDelta` | [`AfterbellHook.sol:31`](contracts/src/AfterbellHook.sol#L31) |
| The fill: price, size, settle, return the delta | [`beforeSwap` 192–217](contracts/src/AfterbellHook.sol#L192-L217), [`_fill` 221–246](contracts/src/AfterbellHook.sol#L221-L246) |
| What one buy can take, at what ask (also the dashboard's quote) | [`quote` 144–158](contracts/src/AfterbellHook.sol#L144-L158), [`_capacity` 162–181](contracts/src/AfterbellHook.sol#L162-L181) |
| The vault's side: send the stock, queue the buy-back | [`AfterbellVault.onHookFill` 398–414](contracts/src/AfterbellVault.sol#L398-L414) |
| Address mining and deploy order (hook → vault → `setVault`) | [`Deploy.s.sol` 101–106](contracts/script/Deploy.s.sol#L101-L106), [`DeployHelpers.mineHookSalt` 62–78](contracts/script/DeployHelpers.sol#L62-L78) |
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

Two facts the vault needs but can't read on-chain come from a CRE workflow ([`packages/cre`](packages/cre)). First, is the US stock market open: Chainlink Data Streams' `marketStatus`. Second, how much NVDA HyperCore's xyz book can absorb: bids within the vault's hedge band, from Hyperliquid's `l2Book`. Every node fetches both. The DON requires the same status from all of them, takes the median capacity, and signs one report to `RiskParams`. The vault caps each liquidation at that capacity, and the hook prices from that status. Neither the vault nor the hook changed: they already read `risk.get()` and `risk.marketOpen()`.

| What | Where |
| --- | --- |
| The workflow: EVM read → two consensus rounds → signed write | [`workflow.ts` `onCronTrigger` 61–104](packages/cre/src/workflow.ts#L61-L104) |
| Data Streams: HMAC auth, v8/v11 `marketStatus` | [`datastreams.ts` 35–119](packages/cre/src/datastreams.ts#L35-L119) |
| Hedge capacity from the book | [`hyperliquid.ts` `readHedgeCapacity` 53–67](packages/cre/src/hyperliquid.ts#L53-L67), [`book.ts` 37–45](packages/cre/src/book.ts#L37-L45) |
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
| `pnpm keeper` / `pnpm keeper:replay`                            | Keeper bot                                                                                          |
| `pnpm test` / `pnpm test:scenarios`                             | Keeper unit tests / keeper against the real contracts on the local stack (below)                    |
| `pnpm --filter @afterbell/cre test` / `compile`                 | CRE workflow on the SDK's test runtime / build its WASM with `cre-compile`                          |
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
pnpm --filter @afterbell/keeper risk-engine:stub   # 3
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
pnpm --filter @afterbell/keeper risk-engine:stub
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
pnpm --filter @afterbell/keeper risk-engine:stub   # own terminal
scripts/testnet-stack.sh keeper                    # own terminal
scripts/testnet-stack.sh crash           # market C 1.4% under HyperCore's oracle → liquidate → hedge
scripts/testnet-stack.sh status
```

HyperCore's oracle can't be moved on testnet, so market C's price follows it and `crash` stays inside the vault's 1.5% oracle band. The keeper runs with top-ups switched off (testnet's CoreDepositWallet would lose the USDC) and without Morpho's API (it doesn't index our Morpho copy). No pool is seeded, so `unwindStep` reverts with `OracleBand` and the keeper skips it; seed one with `SeedPool.s.sol` for the unwind.

## API (dashboard data)

`packages/api` reads everything the dashboard shows once a second and serves it as `GET /snapshot`, `GET /stream` (SSE) and `GET /history`:

- **HyperEVM, in one Multicall3 `eth_call`:** the three Morpho markets and their borrowers, the vault, RiskParams' market-open flag, the v4 pool's `slot0`, and the HyperCore precompiles (vault position, xyz margin, mark and oracle price).
- **Hyperliquid's info API:** `clearinghouseState` (dex `xyz`) for the vault. On the local stack the panel comes from MockHyperCore's precompiles instead.
- **Logs:** vault events and the hook's `InventoryFill` for the activity feed; Morpho's `Liquidate.badDebtAssets` and NaiveLiquidator's `Shortfall` for each market's bad debt. An unwind with an `InventoryFill` in the same transaction is `soldTo: "buyer"`, otherwise `"pool"`.
- **Hook:** `AfterbellHook.quote()` (ask, what one buy can take, the fee now) as the snapshot's `hook` block.

Each market's borrower comes from the deployment file's `borrowers` (`label` = market name).

```bash
NETWORK=local pnpm api                          # after scripts/local-stack.sh up, which also puts Multicall3 on anvil
scripts/check-api.sh deployments/local.json     # every snapshot value against cast call at the same block
NETWORK=testnet pnpm api                        # optional: RPC_URL, FROM_BLOCK (log scan start), POLL_MS
```

`/snapshot` answers 503 until the first poll lands. The hedge ratio is the confirmed short over the vault's own target (inventory in Core size units), so it reads exactly 100% when hedged and 0% while a hedge is in flight. The public testnet RPC rate-limits `eth_getLogs` hard (999-block ranges are always refused, 500 pass), so the scan pages at 500 blocks, and a failed scan only delays the feed. Use a private RPC for the testnet and mainnet demos.

## Keeper notes

- **ABIs come from the contracts.** Every call goes through the wagmi-generated ABIs in `@afterbell/shared/abis`, so a renamed function or changed argument list is a type error. Run `pnpm codegen` after changing a contract.
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
- [x] AfterbellHook on HyperEVM testnet: mined at `0x5Bf6…6088` (flags `0x2088`), pool initialised, a live buy paid its after-hours fee (1%)
- [x] CRE: `hyperliquid-testnet` / `hyperliquid-mainnet` are in the SDK's chain registry; the workflow compiles to WASM with `cre-compile`; the simulation forwarder `0xB27f…24CB` is on HyperEVM testnet
- [ ] CRE CLI simulation with Data Streams credentials (`cre workflow simulate market-feed --broadcast`)
