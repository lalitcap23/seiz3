# Afterbell

A vault that buys seized stock collateral from Morpho, shorts the same stock on HyperCore in the same transaction, then sells the stock into Uniswap v4 while closing the short.

The full design is in `../Afterbell system architecture.md`.

## Layout

```
afterbell/
├─ contracts/            Foundry (solc 0.8.28, cancun)
│  ├─ src/               AfterbellVault, RiskParams, libs/{HedgeLib,UnwindLib,Units}, mocks/
│  ├─ script/            Deploy, CreateMarkets, SeedPool (+ DeployHelpers risk defaults)
│  └─ test/              unit/ (ring 1) · sim/ (ring 2, hyper-evm-lib CoreSimulator) · fork/ (ring 3)
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
| `pnpm contracts:test`                                           | Unit tests (ring 1, no network)                                                                     |
| `pnpm contracts:test:sim`                                       | CoreSimulator tests (forks HyperEVM mainnet)                                                        |
| `pnpm contracts:test:fork`                                      | Morpho + v4 fork tests (`HYPEREVM_RPC_URL`)                                                         |
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
NETWORK=testnet forge script script/Deploy.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
NETWORK=testnet forge script script/CreateMarkets.s.sol --rpc-url hyperevm_testnet --private-key $DEPLOYER_PRIVATE_KEY --broadcast
```

`Deploy.s.sol` rewrites `deployments/<NETWORK>.json`, including the `markets` block. Merge the market ids from `CreateMarkets` back in afterwards; this is still a TODO in that script.

## Status

This is a scaffold. Wiring, storage, interfaces, events, guards and the v4 swap path are in place. Function bodies marked `TODO` follow the architecture doc. Spikes still to run before kickoff:

- [ ] HIP-3 position read (hyper-evm-lib's `position(address,uint32)` takes a uint32, which looks promising)
- [ ] Margin path to `xyz` (`HedgeLib.sendAssetToDex` wraps action 13)
- [ ] Account activation
- [ ] Order delay → `RiskParams.orderDelaySec`
- [ ] Morpho on HyperEVM (address, LLTVs, IRM)
- [ ] Uniswap v4 on HyperEVM (PoolManager / PositionManager)
