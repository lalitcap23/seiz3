# Afterbell × Chainlink Runtime Environment (CRE)

The keeper's decision loop, expressed as a CRE workflow — the **Chainlink "Best workflow with CRE"
track** entry.

```
cron ──► read Morpho position (EVM) ──► read Hyperliquid perp price (HTTP API)
       ──► risk checks (health, oracle band, size cap)              ← chain + external data in one run
       ──► DON-signed report ──► CreKeeperGateway.onReport ──► AfterbellVault.liquidate
```

Why CRE fits: Afterbell runs on HyperEVM, which CCIP has no lane to — but CRE is chain-agnostic
orchestration: it connects the on-chain lending market to the **off-chain, always-open Hyperliquid
market** through plain RPC + HTTP. The vault remains the final authority; CRE is the data-connected,
auditable brain. And the qualification rule says *"simulation is enough"* — that is exactly what
`pnpm test` below produces.

## Do you need any keys?

**No keys for the simulation.**

| Path | Needs |
|---|---|
| `pnpm --filter @afterbell/cre test` (offline simulation) | **nothing** — SDK mocks (EvmMock + stubbed HTTP), no network, no keys |
| CRE CLI dry-run vs a chain (`cre workflow simulate …`) | public RPC only (HyperEVM testnet's is public) |
| `--broadcast` (real on-chain write) | a funded keeper wallet + a deployed `CreKeeperGateway` |
| (optional, not wired) LLM news-check step | an LLM API key in `secrets.yaml` |

The Hyperliquid info API is public — the HTTP step needs no key. `secrets.yaml` at the repo root is a
placeholder for the optional LLM/broadcast keys and is gitignored.

## Run the simulation (the prize deliverable)

```bash
pnpm install
pnpm --filter @afterbell/cre test
```

7 scenarios, all offline: healthy borrower skipped · underwater borrower liquidated · oracle-band
refusal · no-collateral skip · seized-size cap · failed DON write throws · external-data step used.
Expected: `7 passed`.

## Run the workflow with the CRE CLI (deploy/simulate on CRE)

```bash
cd packages/cre
cre workflow simulate my-workflow --target staging-settings          # dry run
cre workflow simulate my-workflow --target staging-settings --broadcast  # real tx (needs wallet + gateway)
```

✅ **Chain support confirmed:** `@chainlink/cre-sdk` 1.6.0's chain registry natively lists
`hyperliquid-testnet` (selector `4286062357653186312n`) and `hyperliquid-mainnet`
(`2442541497099098535n`) — `getNetwork({ chainSelectorName: "hyperliquid-testnet" })` resolves
out of the box, so the CRE CLI can read HyperEVM directly. The offline simulation above is the
prize deliverable; the CLI path is the stretch.

## Layout

```
packages/cre/
├─ src/workflow.ts       the workflow: cron → reads → checks → DON-signed write
├─ src/bindings.ts       EVM reads (Morpho/DemoOracle) + writeReport to the gateway
├─ src/hyperliquid.ts    HTTP step: xyz:NVDA 5m candle → USDC price (external data)
├─ src/risk.ts           pure decision logic (mirrors the keeper's risk engine)
├─ src/main.ts           Runner entry for the CRE CLI
├─ config.staging.json   real HyperEVM testnet addresses from deployments/testnet.json
├─ contracts/CreKeeperGateway.sol   reference receiver (not deployed for the hackathon)
└─ test/workflow.test.ts the 7 offline simulations
```

## How it plugs into the rest of Afterbell

The keeper bot (`packages/keeper`) already liquidates; this workflow is the **orchestration-layer
version of the same rules** — same checks (`oracleBandBps`, health, caps), different brain. In the
pitch it is the institutional angle: *the liquidation decision runs as an attested, versioned CRE
workflow connecting Morpho to Hyperliquid, replayed here as a simulation.*
