# Afterbell

A vault that buys seized stock collateral from Morpho, shorts the same stock on HyperCore in the same transaction, then sells the stock into Uniswap v4 while closing the short.

The full design is in `../Afterbell system architecture.md`.

## Layout

```
afterbell/
├─ contracts/            Foundry (solc 0.8.28 for src/, cancun)
│  ├─ src/               AfterbellVault, RiskParams, libs/{HedgeLib,UnwindLib,Units},
│  │                     mocks/{MockNVDAx,DemoOracle,NaiveLiquidator,PoolSeeder}
│  ├─ script/            Deploy, CreateMarkets, SeedPool (+ DeployHelpers: risk defaults, pool key)
│  └─ test/              unit/ · integration/ (real Morpho + v4 bytecode, MockHyperCore) ·
│                        sim/ (ring 2, hyper-evm-lib CoreSimulator) · fork/ (ring 3) · utils/
├─ packages/
│  ├─ shared/            wagmi-generated ABIs, deployments loader, Snapshot types, unit converters, HL info client
│  ├─ keeper/            Node + viem tick loop (`--replay` for the demo)
│  ├─ api/               Hono: GET /snapshot, GET /stream (SSE), GET /history, POST /replay/:step
│  ├─ replay/            scripted 3-market demo, one step per click
│  └─ web/               Next.js 16 (App Router, Tailwind 4, TanStack Query, Recharts)
└─ deployments/          testnet.json / mainnet.json, written by Deploy.s.sol
```

All addresses and ABIs reach the off-chain code through one path: `forge build` + `Deploy.s.sol` → `deployments/*.json` + `contracts/out` → `@afterbell/shared`.

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
| `pnpm replay <setup\|scene\|marketA\|marketB\|marketC\|monday>` | One demo step                                                                                       |

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

## Testnet end to end (keeper ↔ contracts ↔ real HyperCore)

`scripts/testnet-stack.sh` runs the same flow on HyperEVM testnet, scaled to a 1 NVDAx liquidation (~650 testnet USDC in all). Keys come from `.env.local` (`DEPLOYER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`); the big-blocks switch needs `pip install hyperliquid-python-sdk` (point `PYTHON` at that interpreter).

```bash
scripts/testnet-stack.sh big-blocks on   # the vault and PoolManager only fit in 30M-gas blocks
scripts/testnet-stack.sh infra           # our own Morpho + IRM + v4 PoolManager (testnet has neither)
scripts/testnet-stack.sh deploy
scripts/testnet-stack.sh big-blocks off
scripts/testnet-stack.sh markets         # priced at HyperCore's live NVDA oracle
scripts/testnet-stack.sh actors          # LP deposit, lender, borrower at 76.8% LTV, coreFunded flag (costs 1 USDC)
# by hand: Send 120 USDC (spot) to the vault on HyperCore; post a bid ≥ 1 NVDA on xyz:NVDA near the oracle
scripts/testnet-stack.sh sweep           # spot → xyz margin
pnpm --filter @afterbell/keeper risk-engine:stub   # own terminal
scripts/testnet-stack.sh keeper                    # own terminal
scripts/testnet-stack.sh crash           # market C 1.4% under HyperCore's oracle → liquidate → hedge
scripts/testnet-stack.sh status
```

HyperCore's oracle can't be moved on testnet, so market C's price follows it and `crash` stays inside the vault's 1.5% oracle band. The keeper runs with top-ups switched off (testnet's CoreDepositWallet would lose the USDC) and without Morpho's API (it doesn't index our Morpho copy). No pool is seeded, so `unwindStep` reverts with `OracleBand` and the keeper skips it; seed one with `SeedPool.s.sol` for the unwind.

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
- **In transit.** A deposit to Core is counted for `transitBlocks` blocks (default 1), then the precompile reads take over. Core → EVM needs no entry.
- **Code size.** `UnwindLib` is a linked library to keep the vault under 24 KB; forge links it in scripts and tests.

## Status

Contracts, scripts and tests follow the architecture doc. The offline suite (unit, integration, invariant, scripts) and the CoreSimulator ring pass. The keeper runs against the deployed contracts on the local stack (liquidate → hedge → retry/pause → unwind → margin moves). Spikes still to run before kickoff:

- [x] HIP-3 position read on testnet: `position2` at perp index 650002 and `accountMarginSummary(65, user)` match the info API for live traders. On testnet xyz is DEX 65 (asset 750002), not 1
- [x] Margin path to `xyz`: CoreWriter `sendAsset` spot → xyz works (testnet, 26 blocks). The direct CoreDepositWallet deposit to xyz can't be tested on testnet (below), so mainnet uses spot + `sendAsset`
- [x] Account activation: mainnet CoreDepositWallet deposits create the account (1 USDC fee). Testnet's CoreDepositWallet never credits HyperCore at all, so testnet is funded with HyperCore-side sends (see "After deploy")
- [ ] Order delay → `RiskParams.orderDelaySec`; deposit visibility → `RiskParams.transitBlocks`
- [ ] Leverage on xyz: CoreWriter can't set it. If the default is wrong, `addApiWallet` lets an agent set it
- [x] Morpho on HyperEVM mainnet: `0x68e37dE8…` with 77% and 38.5% LLTVs and the AdaptiveCurve IRM `0xD4a426F0…` enabled. Not on testnet → `TestnetInfra.s.sol`
- [x] Uniswap v4 PoolManager on HyperEVM mainnet: `0x12D4Fd9C…`. Not on testnet → same. `pnpm contracts:test:fork` passes against both
