# Afterbell × Chainlink Runtime Environment (CRE)

The keeper's decision loop, expressed as a CRE workflow — the **Chainlink "Best workflow with CRE"** track entry.

```
cron ──► read Morpho position + market (EVM) ──► read Hyperliquid perp price (HTTP, DON consensus)
      ──► risk checks (Morpho health, oracle band, size cap, core lot)
      ──► DON-signed report ──► CreKeeperGateway.onReport ──► AfterbellVault.liquidate
```

Why CRE fits: Afterbell runs on HyperEVM, which CCIP has no lane to — but CRE is chain-agnostic
orchestration: it connects the on-chain lending market to the **off-chain, always-open Hyperliquid
market** through plain RPC + HTTP. The vault remains the final authority; CRE is the data-connected,
auditable brain. The qualification rule says *"simulation is enough"* — that is what `pnpm test` produces.

## Do you need any keys?

**No keys for the simulation.**

| Path | Needs |
|---|---|
| `pnpm --filter @afterbell/cre test` (offline simulation) | **nothing** — SDK test runtime + stubbed HTTP, no network, no keys |
| CRE CLI dry-run vs a chain (`cre workflow simulate …`) | public RPC only (HyperEVM testnet's is public) |
| `--broadcast` (real on-chain write) | a funded keeper wallet + a deployed `CreKeeperGateway` + the chain's Keystone Forwarder address |
| (optional, not wired) LLM news-check step | an LLM API key in `secrets.yaml` |

The Hyperliquid info API is public — the HTTP step needs no key. `secrets.yaml` at the repo root is a
placeholder for optional keys and is gitignored.

## Run the simulation (the prize deliverable)

```bash
pnpm install
pnpm --filter @afterbell/cre test
```

**12 scenarios, all offline:**

| # | Scenario |
|---|---|
| 1 | healthy borrower → skip |
| 2 | underwater borrower → liquidate |
| 3 | lending/Core oracle gap beyond band → skip |
| 4 | no collateral → skip |
| 5 | seized notional capped at `maxSeizedUsdc` |
| 6 | sizing uses Morpho's LIF, not naive `debt / LLTV` |
| 7 | sub-one-core-lot size → skip (vault would revert `ZeroSize`) |
| 8 | failed DON write throws |
| 9 | external Hyperliquid price feeds the decision |
| 10 | report payload is raw `abi.encode`, not `onReport` calldata |
| 11 | LIF formula matches Morpho (`1.0741…` at 77% LLTV) |
| 12 | borrow shares → assets matches Morpho's virtual shares |
| 13 | HyperEVM testnet resolves in the CRE chain registry |

Expected: `13 passed`. Typecheck: `pnpm --filter @afterbell/cre typecheck`.

The Solidity receiver has its own on-chain proof:

```bash
cd contracts && forge test --match-contract CreKeeperGatewayTest
```

3 tests: the raw `abi.encode` report reaches `vault.liquidate`, a non-forwarder is rejected, and
the 62-byte metadata + workflow-id pinning behave correctly.

## Run the workflow with the CRE CLI

```bash
cd packages/cre
cre workflow simulate my-workflow --target staging-settings               # dry run
cre workflow simulate my-workflow --target staging-settings --broadcast   # real tx (wallet + gateway)
```

✅ **Chain support confirmed in the SDK:** `@chainlink/cre-sdk` 1.6.0's registry lists
`hyperliquid-testnet` (selector `4286062357653186312n`) and `hyperliquid-mainnet`
(`2442541497099098535n`), so `getNetwork({ chainSelectorName: "hyperliquid-testnet" })` resolves.

## Deep check — what was broken and what is now fixed

This package was reviewed against the actual SDK 1.6.0 source and Morpho's contracts. Six real
issues were found and fixed:

1. **Report payload was wrong (would always revert).** `writeReport` delivers the signed payload to
   `gateway.onReport(metadata, report)`; `metadata` is injected by the forwarder. The payload must be
   raw `abi.encode(marketId, borrower, seized)` — not `encodeFunctionData(onReport, …)`. The old code
   nested the call and the gateway's `abi.decode` would fail.
2. **Metadata length check was wrong.** CRE metadata is `abi.encodePacked(bytes32 workflowId,
   bytes10 name, address owner)` = **62 bytes**. The hand-rolled receiver required 86, and would have
   silently decoded `bytes32(0)` for every valid report. Replaced with Chainlink's official
   `ReceiverTemplate` (forwarder allow-list + optional author/name/workflow-id pinning).
3. **HTTP price was single-node.** The plain `sendRequest(runtime, request)` overload executes once,
   with no DON agreement. A liquidation price must be consensus-agreed: now uses the
   `sendRequest(runtime, fn, consensusMedianAggregation())` overload, where every node fetches and
   the DON takes the median.
4. **Seize size was ~21% too large.** Morpho's bonus is
   `min(1.15, 1/(1 − 0.3×(1 − LLTV)))` ≈ **1.0741** at 77% LLTV, not `1/LLTV` ≈ 1.2987. Over-sizing
   makes Morpho revert on repayment. `risk.ts` now reproduces Morpho's exact formula.
5. **Borrow shares were treated as assets.** Morpho stores debt as shares and converts with virtual
   shares/assets (`toAssetsUp`). The workflow now reads `market(id)` totals and converts exactly.
6. **Health used the wrong oracle.** Liquidatability is determined by Morpho's own oracle; using the
   Hyperliquid price could flag a healthy position and revert `HEALTHY_POSITION`. Health now uses the
   lending oracle; the Core price is used for the band check and the vault's notional cap. A
   sub-one-core-lot guard was also added (`ZeroSize` revert).

Also fixed: `gasLimit` was `"1_500_000"` (invalid uint64 string — now `"1500000"`), and the gateway
was moved into `contracts/src/cre/` where Foundry can actually compile it (`forge build` ✅).

### Honest limits

- **Not broadcast.** `--broadcast` needs the gateway deployed and the workflow registered on CRE; the
  hackathon entry is the simulation. The gateway compiles but is not deployed.
- **Bindings tests use test doubles** for the on-chain reads/writes (so the suite is network-free).
  The SDK read/write path is typechecked and the report encoding is asserted byte-for-byte, but the
  live RPC round-trip is not exercised here.
- **`AfterbellVault.liquidate` is permissionless** (no caller allow-list). The gateway is the
  *attested orchestration path*, not the only path; the vault still enforces market allow-list,
  oracle band, notional cap, and margin on every call.
- The `DemoOracle` price conversion assumes the 6/18-dec USDC/NVDAx pair (`USD × 1e24`). A market
  with different token decimals needs the scale adjusted.
- **One borrower per workflow config.** Production would loop a watchlist; the CRE cron would scan
  each borrower in the same run.
- **No report deadline/nonce yet.** The gateway authenticates the DON signature but does not reject a
  stale report; Morpho still re-checks health at execution, but production should add
  `(deadline, nonce)` to the report and reject expired/replayed ones.
- Cron granularity is one minute (`0 */1 * * * *`), matching the official CRE templates.

## Layout

```
packages/cre/
├─ src/workflow.ts       cron → reads → checks → DON-signed write
├─ src/bindings.ts       Morpho/DemoOracle reads + raw report write to the gateway
├─ src/hyperliquid.ts    HTTP step with DON median consensus: xyz:NVDA 5m close → USDC
├─ src/risk.ts           Morpho-exact health, LIF sizing, caps, core-lot guard
├─ src/main.ts           Runner entry for the CRE CLI
├─ config.staging.json   real HyperEVM testnet addresses (deployments/testnet.json)
├─ config.production.json
└─ test/workflow.test.ts the 12 offline simulations

contracts/src/cre/
├─ CreKeeperGateway.sol  authenticates a DON report → vault.liquidate
├─ ReceiverTemplate.sol  Chainlink official reference receiver (MIT)
├─ IReceiver.sol / IERC165.sol
└─ (test) contracts/test/unit/CreKeeperGateway.t.sol — report decoding + auth, 3 forge tests
```

## How it plugs into the rest of Afterbell

The keeper bot (`packages/keeper`) already liquidates; this workflow is the **orchestration-layer
version of the same rules** — same checks (`oracleBandBps`, health, caps), different brain. In the
pitch it is the institutional angle: *the liquidation decision runs as an attested, versioned CRE
workflow connecting Morpho to Hyperliquid, replayed here as a simulation.*

**One-liner for judges:** *"The keeper is a CRE workflow executed by a Chainlink DON — independent
nodes read Morpho and Hyperliquid, agree the position is underwater, and co-sign the liquidation.
Auditable, tamper-resistant, always open."*
