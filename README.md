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
| `pnpm replay <setup\|scene\|marketA\|marketB\|marketC\|monday>` | One demo step                                                                                       |

## Deploying

The vault is too big for a 3M-gas fast block. Switch the deployer to big blocks first, and switch it back afterwards:

```bash
# big blocks on (see Hyperliquid docs: evmUserModify usingBigBlocks=true)
cd contracts
# 1. MockNVDAx, RiskParams, vault, NaiveLiquidator, PoolSeeder; seed deposit; start Core account activation
NETWORK=testnet forge script script/Deploy.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
# 2. three demo markets (one DemoOracle each), market C allow-listed on the vault; merges `markets` into the json
NETWORK=testnet forge script script/CreateMarkets.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
# 3. thin weekend pool; run again with THIN=false for the "Monday" liquidity
NETWORK=testnet THIN=true forge script script/SeedPool.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
```

`Deploy.s.sol` writes `deployments/<NETWORK>.json`; `CreateMarkets.s.sol` merges the `markets` block into it.

### After deploy: fund the hedge account

A new HyperCore account must exist before it sends actions, so margin goes on in later blocks. These calls read the HyperCore precompiles, which `forge script`'s local EVM doesn't have, so use `cast` (it runs against the node):

```bash
# true once the activation deposit has landed (read precompile 0x…0810)
cast call 0x0000000000000000000000000000000000000810 $(cast abi-encode "f(address)" $VAULT) --rpc-url $RPC
cast send $VAULT "sweepSpotToDex()" --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY      # activation leftover → xyz
cast send $VAULT "topUpMargin(uint256)" 20000000000 --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY  # 20k USDC
```

Top-ups go straight to the xyz DEX through CoreDepositWallet. If spike 2 shows that doesn't credit xyz, switch to deposit-to-spot + `sendAsset`: `cast send $VAULT "setMarginDepositDex(uint32)" 4294967295`.

## Contract notes

- **Two ids for one perp.** Orders take the asset id (`110002` for xyz:NVDA); position / oracle reads take the perp index (`10002`). The vault derives the second from the first.
- **Pausing is three flags.** `PAUSE_HEDGE` (hedge unconfirmed after `maxTries`) and `PAUSE_MARGIN` clear themselves on a good `syncHedge`; `PAUSE_OWNER` only clears on `unpause`. Paused stops liquidations and deposits. `unwindStep` still runs under `PAUSE_MARGIN`, which is how a margin-starved vault raises cash, but never under an owner pause or with a hedge in flight.
- **Only allow-listed markets.** Anyone can create a Morpho market with any oracle, so `liquidate` only accepts markets the owner allow-listed (the deploy flow lists market C).
- **Unwind pricing.** Each chunk's swap stops at a `maxImpactBps` price limit, and `minOut` is checked against the Core oracle, the price the short is bought back at.
- **In transit.** A deposit to Core is counted for `transitBlocks` blocks (default 1), then the precompile reads take over. Core → EVM needs no entry.
- **Code size.** `UnwindLib` is a linked library to keep the vault under 24 KB; forge links it in scripts and tests.

## Status

Contracts, scripts and tests follow the architecture doc. The offline suite (unit, integration, invariant, scripts) and the CoreSimulator ring pass. Spikes still to run before kickoff:

- [ ] HIP-3 position read on testnet (the simulator agrees with `position2(address,uint32)` at perp index 10002)
- [ ] Margin path to `xyz` (direct CoreDepositWallet deposit vs spot + `sendAsset`; both are implemented)
- [ ] Account activation (`activateCore` → `coreUserExists`)
- [ ] Order delay → `RiskParams.orderDelaySec`; deposit visibility → `RiskParams.transitBlocks`
- [ ] Leverage on xyz: CoreWriter can't set it. If the default is wrong, `addApiWallet` lets an agent set it
- [ ] Morpho on HyperEVM (address, LLTVs, IRM) → then `pnpm contracts:test:fork`
- [ ] Uniswap v4 on HyperEVM (PoolManager) → same
