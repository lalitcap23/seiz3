# Seiz3

A vault that buys seized stock collateral from Morpho, shorts the same stock on HyperCore, then sells the stock through Uniswap v4 while closing the short: buyers on the vault's pool are filled from its hedged stock by a v4 hook, and the keeper pushes whatever nobody buys. A Chainlink CRE workflow tells the contracts whether the stock market is open, how much HyperCore's book can hedge, and what the hedge account on HyperCore holds.

Live on Base Sepolia at [seiz3.xyz](https://seiz3.xyz) (API: [api.seiz3.xyz](https://api.seiz3.xyz)).

## Architecture

The vault lives where Morpho and Uniswap both have their own deployments: Base Sepolia. Morpho Blue `0xBBBB…FFCb` (no IRM and AdaptiveCurveIrm, 77% and 38.5% LLTVs enabled) and the v4 PoolManager `0x05E7…3408` are theirs; nothing of either is redeployed. The short lives on HyperCore testnet (xyz:NVDA), in a hedge account the relayer controls.

```
Base Sepolia                                              HyperCore testnet
Morpho (theirs) ─liquidate─► Seiz3VaultRemote ─placeOrder─► HyperCoreGateway ─► relayer ─IOC─► hedge account (short)
Uniswap v4 (theirs) ◄─ Seiz3HookRemote ─┘   ▲                     ▲   ◄── snapshot + ack ──┘          │
                                                └─ reads (precompile   └── Chainlink CRE: DON-signed snapshot ◄┘
                                                   shapes) ─────────        of the hedge account, + RiskParams
```

| Piece | What it is |
| --- | --- |
| [`Seiz3VaultRemote`](contracts/src/remote/Seiz3VaultRemote.sol) | ERC-4626 USDC vault: liquidates on Morpho, queues the matching short on the gateway, unwinds into Uniswap v4. `syncHedge` waits for the gateway's `settled()`; margin moves revert `NoBridge` (the hedge account is funded on HyperCore) |
| [`Seiz3HookRemote`](contracts/src/remote/Seiz3HookRemote.sol) | The v4 hook on the vault's pool: fills buyers from the vault's stock and sets the fee by market hours; its HyperCore reads go through the gateway |
| [`HyperCoreGateway`](contracts/src/remote/HyperCoreGateway.sol) | HyperCore's precompiles + CoreWriter for a chain without them: stores the vault's orders for the relayer, serves the precompile-shaped reads from the last snapshot (newer of relayer / CRE wins; older than `maxStateAge` → reads revert, the vault fails closed), and `settled()` once every order is acknowledged |
| [`RiskParams`](contracts/src/RiskParams.sol) | Owner-set caps, overridden by the CRE report (market status, hedge capacity) |
| [`packages/relayer`](packages/relayer) | Places each gateway order on HyperCore from the hedge account (vault's cloid; never twice), posts the account back with the acknowledgement, heartbeats in between. `BACKEND=hyperliquid`, or `mock` (MockHyperCore on anvil) |
| [`packages/keeper`](packages/keeper) | Liquidates under-water market C borrowers, syncs the hedge, unwinds in chunks |
| [`packages/cre`](packages/cre) | The CRE workflow (`base-feed/`): market feed → RiskParams, plus every node's own read of the hedge account → one DON-signed snapshot to the gateway |
| [`packages/bots`](packages/bots) | Demo counterparties: oracle follower, pool rebalancer, HyperCore market maker, a buyer through the hook, utilization holder, alerts |
| [`packages/api`](packages/api), [`packages/web`](packages/web) | Dashboard data (`/snapshot`, `/stream`, faucet relay) and the Next.js dashboard + `/try` tester page |

## Layout

```
seiz3/
├─ contracts/            Foundry (solc 0.8.28 for src/, cancun)
│  ├─ src/               remote/{Seiz3VaultRemote,Seiz3HookRemote,HyperCoreGateway}, RiskParams, interfaces/ISeiz3Vault,
│  │                     libs/{HedgeLib,UnwindLib,Units}, cre/ (Chainlink ReceiverTemplate),
│  │                     mocks/{MockNVDAx,MockUSDC,DemoOracle,NaiveLiquidator,PoolSeeder,Faucet}
│  ├─ script/            RemoteInfra, DeployRemote, CreateMarkets, SeedPool, RemoteExtras, RemoteActors (+ DeployHelpers)
│  └─ test/              unit/ · remote/ (gateway; the whole round on real Morpho + v4 bytecode, MockHyperCore behind a
│                        test relayer; NaiveLiquidator) · fork/ (the same round on Base Sepolia's own Morpho + PoolManager)
├─ packages/
│  ├─ shared/            wagmi-generated ABIs, deployment schema + loader, Snapshot types, unit converters, HL info client
│  ├─ keeper/            Node + viem tick loop (+ the risk-engine stub it asks for each decision)
│  ├─ relayer/           gateway orders → HyperCore, HyperCore state → gateway
│  ├─ api/               Hono: GET /snapshot, GET /stream (SSE), GET /history, POST /faucet, POST /watch
│  ├─ bots/              demo counterparties (see above)
│  ├─ cre/               Chainlink CRE workflow
│  └─ web/               Next.js 16 (App Router, Tailwind 4, TanStack Query, Recharts)
├─ scripts/              base-stack.sh (deploy + run everything), check-api.sh, vps-deploy.sh
└─ deployments/          <network>.json written by the deploy scripts (git-ignored)
```

All addresses and ABIs reach the off-chain code through one path: `forge build` + `DeployRemote.s.sol` → `deployments/*.json` + `contracts/out` → `@seiz3/shared`.

## Uniswap v4 hook (Seiz3HookRemote)

The vault's NVDAx/USDC pool carries [`Seiz3HookRemote`](contracts/src/remote/Seiz3HookRemote.sol) with a dynamic fee. A buyer of NVDAx is filled from the vault's hedged inventory at the HyperCore oracle price plus a spread, off the curve, and each fill queues the matching reduce-only buy on HyperCore. Whatever the hook doesn't fill goes to the curve at a fee set by market hours.

| What | Where |
| --- | --- |
| Permissions: `beforeInitialize`, `beforeSwap`, `beforeSwapReturnDelta` | [`SEIZ3_HOOK_FLAGS`](contracts/src/remote/Seiz3HookRemote.sol#L31) |
| The fill: price, size, settle, return the delta | [`beforeSwap` 196–221](contracts/src/remote/Seiz3HookRemote.sol#L196-L221), [`_fill` 225–250](contracts/src/remote/Seiz3HookRemote.sol#L225-L250) |
| What one buy can take, at what ask (also the dashboard's quote) | [`quote` 148–162](contracts/src/remote/Seiz3HookRemote.sol#L148-L162), [`_capacity` 166–185](contracts/src/remote/Seiz3HookRemote.sol#L166-L185) |
| The vault's side: send the stock, queue the buy-back | [`Seiz3VaultRemote.onHookFill` 375–391](contracts/src/remote/Seiz3VaultRemote.sol#L375-L391) |
| Address mining and deploy order (hook → vault → `setVault`) | [`DeployRemote.s.sol` 80–100](contracts/script/DeployRemote.s.sol#L80-L100), [`_deployHook` 123–129](contracts/script/DeployRemote.s.sol#L123-L129), [`DeployHelpers.mineHookSalt` 62–78](contracts/script/DeployHelpers.sol#L62-L78) |
| Tests | `test_hookFill_sellsToABuyerAndTheBuyBackIsRelayed` in [`RemoteFlow.t.sol`](contracts/test/remote/RemoteFlow.t.sol), and the same against Base Sepolia's PoolManager in [`BaseSepoliaFork.t.sol`](contracts/test/fork/BaseSepoliaFork.t.sol) |

Rules:

- **When it fills.** A fill happens under the same rules as `unwindStep`: no owner pause, no hedge in flight, and the short within `maxUnhedged` of −inventory. One fill is at most `maxUnhedged`, on whole Core size units.
- **When it passes.** The hook sells only when the pool trades at or above its ask, so a buyer never pays more than the curve's price. A fill sets the vault's pending hedge, so the next buyer goes to the curve until `syncHedge` confirms the buy-back.
- **Ask and fee.** Defaults (`setSettings`):
  - spread over the Core oracle: 0.10% while the market is open, 1% after the bell;
  - curve fee: 0.30% while open, 1% after the bell.
  - The vault's own `unwindStep` sells always pay the open fee.
- **Fails open.** If a gateway read fails (stale snapshot), swaps still go through the curve at the closed fee, and nothing is sold from the vault.
- **Market A's own pool.** Market A dumps into its own hookless pool (`thinPoolKey`), so the vault's pool stays near the oracle.

Deploying needs the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which is on anvil and Base Sepolia. Uniswap's hackathon feedback is in [FEEDBACK.md](FEEDBACK.md).

## Chainlink CRE workflow

Three facts the contracts need but can't read on-chain come from a CRE workflow ([`packages/cre`](packages/cre), target `base-feed`):

1. **Is the US stock market open.** Chainlink Data Streams' `marketStatus` for NVDA (the regular-hours v11 stream on the testnet Data Engine; every node must agree). `marketStatus: "marketHours"` computes the exchange's regular session from the DON's clock instead, with session times and the holiday calendar in the config.
2. **How much NVDA HyperCore's xyz book can absorb:** bids within the vault's hedge band, from Hyperliquid's `l2Book`. Every node fetches the book; the DON takes the median.
3. **What the hedge account holds on HyperCore:** every node reads it from Hyperliquid's info API, and the DON signs one snapshot to the gateway. It keeps the vault's reads fresh if the relayer stops; only the relayer acknowledges orders.

The workflow also reads Chainlink's free **NVDA/USD Data Feed** on Ethereum and compares it with HyperCore's oracle: outside the vault's oracle band, the report carries zero capacity (`enforce`; off on testnet, where HyperCore's oracle isn't the real price).

| What | Where |
| --- | --- |
| The workflow: EVM read → book consensus → market status → Data Feed check → signed writes | [`workflow.ts` `onCronTrigger` 136–192](packages/cre/src/workflow.ts#L136-L192) |
| Market status source: Data Streams or market hours | [`workflow.ts` `readMarket` 100–130](packages/cre/src/workflow.ts#L100-L130), [`marketHours.ts`](packages/cre/src/marketHours.ts) |
| Data Streams: HMAC auth, v8/v11 `marketStatus` | [`datastreams.ts` 53–146](packages/cre/src/datastreams.ts#L53-L146) |
| Chainlink Data Feed price check | [`dataFeed.ts` 47–78](packages/cre/src/dataFeed.ts#L47-L78) |
| Hedge capacity from the book | [`hyperliquid.ts` `readHedgeCapacity` 54–69](packages/cre/src/hyperliquid.ts#L54-L69), [`book.ts` 37–45](packages/cre/src/book.ts#L37-L45) |
| The hedge account snapshot to the gateway | [`gateway.ts`](packages/cre/src/gateway.ts) |
| The receiver: report → state, ordering, future guard | [`RiskParams._processReport` 104–111](contracts/src/RiskParams.sol#L104-L111) |
| The vault's cap: `maxLiquidation` lowered to the capacity, 0 once stale | [`RiskParams.get` 65–72](contracts/src/RiskParams.sol#L65-L72), [`_report` 114–119](contracts/src/RiskParams.sol#L114-L119) |
| The hook's fee and the unwind cooldown | [`RiskParams.marketOpen` 80–83](contracts/src/RiskParams.sol#L80-L83) |
| Tests | [`workflow.test.ts`](packages/cre/test/workflow.test.ts), [`gateway.test.ts`](packages/cre/test/gateway.test.ts) (SDK test runtime), [`RiskParams.t.sol`](contracts/test/unit/RiskParams.t.sol), [`HyperCoreGateway.t.sol`](contracts/test/remote/HyperCoreGateway.t.sol) |

A report older than `maxReportAge` (300 s) fails closed: no liquidations, and after-hours pricing. `setMaxReportAge(0)` hands control back to the owner's values. `scripts/base-stack.sh sepolia cre-loop` reports every minute, as a DON would; CRE reads RiskParams at the latest block, since Base Sepolia's finalized head trails by hours. How to run the CLI by hand is in [packages/cre/README.md](packages/cre/README.md).

## Setup

```bash
git submodule update --init --recursive   # Solidity libs
pnpm install
cp .env.example .env.local                # keys + RPC
pnpm codegen                              # forge build + wagmi ABIs → packages/shared/src/generated
```

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm contracts:test` | Unit + remote tests, offline: real Morpho Blue and v4 PoolManager bytecode, MockHyperCore behind a test relayer |
| `pnpm contracts:test:fork` | The same round on Base Sepolia's own Morpho + PoolManager (`BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`); skips without it |
| `pnpm codegen` | Rebuild contracts and regenerate TS ABIs |
| `pnpm typecheck` | Typecheck every package |
| `pnpm test` | Keeper unit tests (`pnpm --filter @seiz3/relayer test`, `pnpm --filter @seiz3/cre test` for the others) |
| `pnpm base:up` / `base:logs` / `base:ps` / `base:down` | The whole Base Sepolia stack in docker (below) |
| `pnpm vps:deploy` | Ship the working tree to the VPS behind seiz3.xyz |

## Running it

`scripts/base-stack.sh local|fork|sepolia <command>` deploys and runs everything (its header has the full list):

- **local**: plain anvil on :8546, Morpho/v4 bytecode set up like Base Sepolia's, MockHyperCore behind the relayer. `up`, `relayer`, `activate`, `keeper`, then `round`: weekend → borrow → crash → liquidate → relayed short → hook fill → relayed buy-back → Monday unwind → flat, each step checked.
- **fork**: anvil forking Base Sepolia on :8547 (`anvil --fork-url https://sepolia.base.org --port 8547`): the same, against Morpho's and Uniswap's real deployments and Chainlink's real CRE forwarder (`cre --broadcast` lands both reports).
- **sepolia**: `infra`, `deploy`, `markets`, `seed deep|thin`, `actors`, `extras`, fund the hedge account on HyperCore + `to-xyz`, `relayer`, `activate`, `keeper`, `bots`, `cre-loop`, then `crash` / `release` / `borrow` / `hook-fill` / `status`.

`pnpm base:up` runs every service in docker (`docker-compose.base.yml`: risk engine, relayer, keeper, bots, the Chainlink CRE loop every minute, API on :8788, web on :3001; `pnpm base:down` also takes the market maker's quotes off HyperCore). Each container runs `scripts/base-stack.sh sepolia <service>` with keys from `.env.local`; the CRE container uses the host's `cre login` (`~/.cre`). Without docker, `scripts/base-stack.sh sepolia live` starts the same services in one terminal (logs in `deployments/base-logs/`). Run one or the other, never both: two relayers place every HyperCore order twice.

### Try it yourself

Open `http://localhost:3001/try` (or [seiz3.xyz/try](https://seiz3.xyz/try)) with a wallet on Base Sepolia:

1. **Get test tokens**: the faucet sends 1 NVDAx, 500 USDC and gas (the API pays the gas, so a new wallet works).
2. **Lend USDC** on Morpho market C.
3. **Deposit NVDAx** and **borrow Max**: right at the 77% LLTV. Market C runs on Morpho's AdaptiveCurveIrm at ~90% utilization (the bots' `util`), so interest tips it over ~15 s after the borrow lands. To keep a loan open, borrow less than Max.
4. **Get liquidated** live: the keeper liquidates you, the vault holds your NVDAx, and the relayer shorts it on HyperCore.
5. **Watch it unwind** on the dashboard: first to a buyer through the v4 hook at its ask, then into the pool, each sale bought back on HyperCore. The keeper waits up to 60 s for a buyer after each liquidation (`BUYER_WINDOW_SEC`), the bots' buyer takes the first fill, and the pool sits just over the hook's ask while the vault holds stock (`POOL_ABOVE_ASK_BPS`), so you can also buy from the vault on the Swap card yourself.

The hedge account's 115 USDC of HyperCore margin covers about 1.3 NVDA of short at the vault's 3× margin check: one faucet drip per liquidation fits; bigger positions need more margin on `0x6011…40cB` (send USDC on HyperCore, then `to-xyz`).

### Live on Base Sepolia

`deployments/base-sepolia.json`: vault [`0x9557…6c20`](https://sepolia.basescan.org/address/0x9557cd78f2332fb661eBd0017eE057cD4A086c20), hook `0x4fbe…2088`, gateway `0x6db0…d826`, RiskParams `0xce19…0990`, on Morpho `0xBBBB…FFCb` and PoolManager `0x05E7…3408`. Hedge account on HyperCore testnet `0x6011…40cB`. One full round on 2026-11-07:

| Step | Where | Transaction |
| --- | --- | --- |
| LP deposit 100 USDC | Base Sepolia | `0x066fab58…9882` |
| Borrow to 76.8% LTV, market C 1.4% under HyperCore | Base Sepolia | `scripts/base-stack.sh sepolia borrow` / `crash` |
| Keeper liquidates 1.054 NVDAx | Base Sepolia | `0xe14f8062…5bc9` |
| Relayer opens the short, 1.054 @ $212.23 (vault's cloid `0x6863…936f`) | HyperCore testnet | `0x64d435dd…e017` |
| `syncHedge` confirms −1054 through the gateway | Base Sepolia | `0x2a6bf640…5138` |
| 3 unwind chunks into Uniswap v4, each bought back on HyperCore (0.5 + 0.5 + 0.054 @ $213.51) | both | `0x624cf9fb…`, `0x32e4a03f…`, `0x526f57c6…` |
| Vault flat; CRE reports every minute (Data Streams status 2, equity book, HyperCore depth, hedge attestation) | Base Sepolia | via forwarder `0x8230…f3e5` |

What keeps a round clean (found by auditing the hedge account's HyperCore order history, `historicalOrders`):

- **Every buy-back clears HyperCore's $10 minimum.** An unwind chunk stops at `maxImpactBps` of pool price impact; on a thin pool that can be under $10, which HyperCore rejects (`minTradeNtlRejected`). Raise `maxImpactBps` / `maxSlippageBps` until a chunk clears it.
- **The market maker never leaves the vault without an ask.** While the vault holds stock it keeps an ask for min(stock, `maxUnhedged`) from the chain (a hook fill sends its buy-back with no warning), keeps any ask that still covers the next buy instead of churning it, and places a replacement before cancelling. Its bid (`MM_SIZE`) rests at full size: it is what a liquidation's hedge sells into, so it sets the CRE hedge capacity.
- **The keeper's breaker retries after a minute** (`BREAKER_COOLDOWN_MS`): RPC timeouts count as failed sends, and without it three in a row stopped the keeper until a restart.

## API (dashboard data)

`packages/api` reads everything the dashboard shows once a second and serves it as `GET /snapshot`, `GET /stream` (SSE) and `GET /history`:

- **Base Sepolia, in one Multicall3 `eth_call`:** the three Morpho markets and their borrowers, the vault, RiskParams' market-open flag, the v4 pool's `slot0`, and the gateway's HyperCore reads (position, xyz margin, mark and oracle price).
- **Hyperliquid's info API:** `clearinghouseState` (dex `xyz`) for the hedge account. On the local stack the panel comes from the gateway (MockHyperCore) instead.
- **Logs:** vault events and the hook's `InventoryFill` for the activity feed; Morpho's `Liquidate.badDebtAssets` and NaiveLiquidator's `Shortfall` for each market's bad debt. An unwind with an `InventoryFill` in the same transaction is `soldTo: "buyer"`, otherwise `"pool"`.
- **Hook:** `quote()` (ask, what one buy can take, the fee now) as the snapshot's `hook` block.

`scripts/check-api.sh deployments/local-base.json` checks every snapshot value against `cast call` at the same block. `/snapshot` answers 503 until the first poll lands. The hedge ratio is the confirmed short over the vault's own target (inventory in Core size units), so it reads exactly 100% when hedged and 0% while a hedge is in flight.

## Keeper notes

- **ABIs come from the contracts.** Every call goes through the wagmi-generated ABIs in `@seiz3/shared/abis`, so a renamed function or changed argument list is a type error. Run `pnpm codegen` after changing a contract.
- **It mirrors the vault's rules, the contract decides.** Pauses, cooldowns and Morpho's liquidation maths (seize no more than the debt and idle USDC can repay) are checked before simulating; an `eth_call` that reverts anyway (pool or lending oracle out of band, low HyperCore margin, stale gateway) is skipped and logged with its error name, not sent and not counted by the breaker.
- **Block clock.** Order delays and cooldowns are compared against the latest block's timestamp, the clock the vault uses.
- **No margin moves.** The hedge account is funded on HyperCore; once its margin is back the keeper syncs to clear a margin pause.

## Contract notes

- **Two ids for one perp.** Orders take the asset id (`750002` for xyz:NVDA on HyperCore testnet); position / oracle reads take the perp index (`650002`). The vault derives the second from the first.
- **Pausing is three flags.** `PAUSE_HEDGE` (hedge unconfirmed after `maxTries`) and `PAUSE_MARGIN` clear themselves on a good `syncHedge`; `PAUSE_OWNER` only clears on `unpause`. Paused stops liquidations and deposits. `unwindStep` still runs under `PAUSE_MARGIN`, which is how a margin-starved vault raises cash, but never under an owner pause or with a hedge in flight.
- **Only allow-listed markets.** Anyone can create a Morpho market with any oracle, so `liquidate` only accepts markets the owner allow-listed (the deploy flow lists market C).
- **Unwind pricing.** Each chunk's swap stops at a `maxImpactBps` price limit, and `minOut` is checked against the Core oracle, the price the short is bought back at.
- **The gateway decides freshness.** Every HyperCore read the vault or hook makes goes through the gateway's last snapshot; one older than `maxStateAge` reverts, so share maths, liquidations and hook fills fail closed.
- **CRE report.** `RiskParams` is the CRE receiver (`ReceiverTemplate`, forwarder pinned). The vault reads its cap and market flag through `risk.get()` / `risk.marketOpen()`.
- **Code size.** `UnwindLib` is a linked library to keep the vault under 24 KB; forge links it in scripts and tests. `Seiz3VaultRemote` is 21,935 bytes, 2,641 under the limit.
- **Dust counts as flat.** Hook fills sell whole Core size units, so less than one unit of stock can be left behind. `syncHedge` treats that dust as no stock and closes the short fully, as the keeper already assumes.
