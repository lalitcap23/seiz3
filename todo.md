Yes, that order still holds. I'd change one thing: do the ETHGlobal rules check first, because the answer could change whether you can use this repo at all.

## Afterbell TODO

### 0. Hackathon rules

- [x] Read the current ETHGlobal rules on code written before the event.

- [x] Decide whether you disclose this repo or rebuild at the event.

- ✅ **Done when:** you know what you'll say about this repo when you submit.

### 1. Commit loose files

- [x] Commit `scripts/` and `Afterbell system architecture.md`.

- ✅ **Done when:** `git status` is clean.

### 2. Testnet spikes (in this order)

**a. Account activation**

- [x] Deposit USDC to HyperCore.

- [x] Poll `coreUserExists` until it returns true.

- [x] Send one CoreWriter action.

- ✅ **Done when:** the action shows up on Core and isn't silently dropped.
- → **Result:** testnet's CoreDepositWallet never credits HyperCore (31 USDC lost, new and existing accounts alike). A HyperCore-side send created the account at once. Mainnet deposits work and create new accounts (1 USDC fee). First CoreWriter action (`sendAsset` spot → xyz) landed in 26 blocks.

**b. Margin path to xyz**

- [x] Try CoreDepositWallet with the DEX index.

- [x] If xyz isn't credited, use `setMarginDepositDex(4294967295)` plus `sendAsset`.

- ✅ **Done when:** `clearinghouseState` with `dex: "xyz"` shows the margin. Write down which path worked.
- → **Result:** direct-to-xyz can't be tested on testnet (its deposit contract is broken). `sendAsset` spot → xyz works (3–26 blocks). Path for mainnet: deposit to spot + `sendAsset` (`setMarginDepositDex(4294967295)`). Testnet: fund the vault with HyperCore-side sends.

**c. HIP-3 order and position read**

- [x] Find which HIP-3 market exists on testnet (xyz:NVDA might not be listed).

- [x] Place an order, then read the position through the precompile using an asset id above 100,000.

- ✅ **Done when:** the precompile and the API report the same position size.
- → **Result:** xyz:NVDA is listed on testnet, but xyz is DEX 65 there: asset 750002, read index 650002 (mainnet: 1 / 110002 / 10002). IOC short of 0.05: precompile `-0.050` = API `-0.05`. The testnet book is very thin (≈0.1 NVDA of bids).

**d. Order delay**

- [x] Time order to fill over several tries.

- [x] Set `orderDelaySec` and the keeper's wait time from those numbers.

- ✅ **Done when:** the numbers are written down and both values are set.
- → **Result:** 2 tries, both 1 block / 2 s. The default `orderDelaySec = 5` stays (the keeper reads it from `RiskParams`).
- → **Found:** Hyperliquid rejects orders priced too far from the oracle (`oracleRejected`: +15% rejected, +10% accepted). The vault's ±1% is safe. But the testnet NVDA book sits far from the oracle (asks from +12%, bids used up), so for step 3 **post your own bids and asks near the oracle from the main wallet**, or the vault's orders can't fill.
- → **Open:** the spike wallet is still short 0.084 NVDA (liquidates at $239.67). Close it once there's an ask near the oracle.

**e. Morpho and Uniswap v4 on HyperEVM**

- [x] Confirm both addresses.

- [x] Confirm the 77% and ~38.5% LLTVs are enabled.

- → **Result (mainnet):** Morpho `0x68e37dE8d93d3496ae143F2E900490f6280C57cD` (77% + 38.5% enabled), IRM `0xD4a426F010986dCad727e8dd6eed44cA4A9b7483`, Uniswap v4 PoolManager `0x12D4Fd9C5DeDd00ab8a0bCe2CF0167bbf94b6B1F`.
- → **Testnet:** neither exists, so `contracts/script/TestnetInfra.s.sol` deploys our own copies (same real code). Run it first in step 3.

- [x] Run `pnpm contracts:test:fork`. (2/2 pass. Needed `disable_block_gas_limit` in the sim profile.)

- ✅ **Done when:** the fork tests pass.

### 3. Testnet deploy and first real hedge (go/no-go)

All through `scripts/testnet-stack.sh` (README, "Testnet end to end"). Scaled to a 1 NVDAx liquidation.

- [x] Fund the deployer (0.05 HYPE + 450 USDC on HyperEVM, HyperCore account) and the keeper (0.02 HYPE).

- [x] Rehearse infra → deploy → markets → actors on a local fork of testnet.

- [x] `big-blocks on` (deployer).

- [x] `infra`: Morpho `0xbE54b050F303Aa1a4CD1d354c20b341071632AB0`, IRM `0xc21aA4331F5EF75625004bC4AcA14480247e1b4F`, PoolManager `0xce19e7C888D3b4c3a6E2e55e2C516b1A8e2d0990`.

- [x] `deploy`: **vault** `0x6c6496fB365AAC734F55F99aAE51357906d73D9C` (all addresses in `deployments/testnet.json`).

- [x] `big-blocks off`

- [x] `markets`: A, B, C created; C allow-listed on the vault.

- [x] `actors`: vault 209 USDC idle, market C 180 supplied / 162.84 borrowed against 1 NVDAx at $212.03, coreFunded on.

- [x] **You:** Send 120 USDC (spot) to the vault's address on app.hyperliquid-testnet.xyz.

- [x] `sweep`: vault spot → xyz margin (120 USDC, landed in ~3 s).

- [x] **You:** post a buy (limit) for ≥ 1 NVDA on xyz:NVDA about 0.3% under the oracle (1.0 @ 211.70).

- [x] Risk engine + `keeper` in their own terminals.

- [x] `crash` → the keeper liquidates → the vault shorts → `syncHedge` confirms.

- → **Result: GO.** Market C $209.52 vs HyperCore $212.49:
  - Liquidation + short in one tx, block 67683370: `0xeebcd35f0eed9376c63339fe6cd5cfd6f83e2d7c7d16f117395044933de242cd`. Seized 0.8348 NVDAx, repaid ~162.84 USDC.
  - Hyperliquid fills, one order (oid 63489304041): SELL 0.101 @ 220.31 + 0.733 @ 211.70 = **-0.834 NVDA**.
  - `syncHedge` confirmed 10 blocks later: `0x9ae57047b1276d869210043910b308ea72bd3f0bee49647bd2a840e185fcb607`. confirmedShort -834 = target.
  - Vault now: 0.8348 NVDAx inventory, short -0.834 (entry 212.74, liq. price $347.91), xyz account 120.27 USDC, 46.16 USDC idle.
  - Not done on testnet yet: the unwind (needs a seeded pool + an ask near the oracle) → step 7.
- ✅ **Go:** a short opens on Core and the vault reads it back.
- ❌ **No-go:** show the simulator in the Afterbell column instead.

### 4. API collector (local stack, can run alongside 2–3)

- [x] Every second, read the 3 Morpho markets, the vault fields and the pool price in one multicall. (Multicall3 also carries the HyperCore precompile reads; `local-stack.sh up` now puts Multicall3 on anvil.)

- [x] Fetch `clearinghouseState` with `dex: "xyz"`. (Testnet/mainnet. Locally the panel comes from MockHyperCore's precompiles.)

- [x] Collect vault events for the activity feed. (Plus bad debt: Morpho `Liquidate.badDebtAssets` + NaiveLiquidator `Shortfall`.)

- ✅ **Done when:** the collector's values match `cast call` results against anvil.
- → **Result:** `scripts/check-api.sh deployments/local.json` → **21 match, 0 differ**, before and after a full liquidate → hedge → unwind run. The API showed the hedge ratio 100% → **0%** (liquidated, hedge pending) → **100%** (confirmed) within 3 s, and 113–138% for a moment during each unwind chunk.
- → **Testnet:** same collector against the step-3 vault: one-multicall read works with real HyperCore, the Hyperliquid panel comes from the info API, and the activity feed rebuilt the step-3 LiquidationTaken / HedgeSent / HedgeConfirmed. The public testnet RPC refuses 999-block `eth_getLogs`, so the scan pages at 500. **Get a private RPC for steps 7–8.**
- → **Not testable yet:** market A's bad debt and markets A/B borrowers need the replay `scene` / `marketA` steps (step 5).

### 5. Replay steps

- [x] `setup` (`scripts/local-stack.sh demo`: thin pool, borrowers A 76% / B 30% / C 76%, NaiveLiquidator funded, keeper held, anvil snapshot)

- [x] `scene` (set all 3 oracles, and MockHyperCore, to $205)

- [x] `marketA` (NaiveLiquidator)

- [x] `marketC` (releases the held keeper, waits for the confirmed hedge)

- [x] `monday` (arbitrage swap back to the oracle via new `PoolSeeder.swapToPrice`, deep pool, market-open flag, keeper unwinds)

- [x] Connect `POST /replay/:step` to them.

- [x] Extra: `reset` rewinds anvil to setup's snapshot, so a rerun takes seconds instead of a fresh deploy.

- ✅ **Done when:** all the steps run in order on a fresh anvil without errors.

- → **Result:** all steps through `POST /replay/:step`, twice (fresh anvil, then after `reset`), identical both times:
  - scene: A and C 80.4% LTV (liquidatable), B 31.8% of 38.5% (healthy)
  - marketA: 86.4 NVDAx dumped for $1,857 → **$14,635 bad debt**
  - marketC: vault holds 86.4 NVDAx, short −86.411, hedge ratio 100% → 0% → 100%
  - monday: 9 unwind chunks to zero stock / zero short; **share price 0.999 → 1.010**; market C bad debt $0
- → **Testnet:** `scene` / `marketA` / `marketC` / `monday` are written for testnet too (drop = live HyperCore oracle −1.4%), but testnet only has a market C borrower so far → step 7.

### 6. Dashboard on live data (local)

- [x] Connect the dashboard to the collector. (Live over SSE. Added what the story needs: weekend/Monday badge, pool vs HyperCore price with "thin pool drained" / "waits for buyers", market status chips, stock held / short confirmed / short on HyperCore bars, activity feed, presenter bar at `?presenter=<REPLAY_TOKEN>`.)

- [x] Run the full demo on anvil 3 or more times in a row.

- ✅ **Done when:** the hedge ratio dips to 0% and snaps back to 100% on every run.

- → **Result:** 4 full shows in a row, clicked through the dashboard's own presenter buttons in headless Chrome, `reset` between them. Every run: hedge ratio **0% → 100% in 3 s** at Market C; A's bad debt $14,635; C's $0; share price 0.999 → 1.011 (Market C) → 1.010 (Monday, after fees); Monday unwinds to zero.
- → **Fixed on the way (all only showed up after `reset`):** keeper reused a pre-rewind nonce (Market C stalled 60 s) → resets its nonce when the chain goes back; the HyperCore ticker waited on a lost receipt (hedge stuck at 0% for 78 s) → 5 s receipt timeout + `reset` drops leftover txs; the replay polled receipts every 4 s → 250 ms (Weekend gap 24 s → 7 s).
- → **Story note:** LPs' gain shows at the **Market C** click (stock bought at Morpho's ~7% discount, marked at HyperCore's price). Monday converts it to cash and costs a little in fees. Say it that way on stage.

### 7. Full demo on testnet

Built (no redeploy of the vault `0x6c64…`):

- [x] Contracts: `Faucet` (operator drips NVDAx, USDC, HYPE once a day), `PoolSwapTest` as public swap router, `NaiveLiquidator` on its own thin 0.05% pool (`TestnetExtras.s.sol`). `SeedPool` seeds the thin pool with `THIN=true`.
- [x] Keeper: finds borrowers from Morpho `Borrow` events (from `startBlock`), and counts interest Morpho hasn't booked yet, so a "borrow max" loan is liquidated on its own.
- [x] `packages/bots`: oracle follower, pool rebalancer, HyperCore market maker, alerts. They hold while `deployments/BOTS_HOLD` exists (crash / replay scene).
- [x] API: `POST /faucet` (operator key, one per IP per hour), thin pool in the snapshot, replay refuses `REPLAY_TOKEN=change-me` off local.
- [x] Replay on testnet: `setup` in viem (oracles on HyperCore, lenders topped up, fresh borrowers), `monday` resets the thin pool and releases the bots.
- [x] Web: `/try` page: wallet connect (chain 998), faucet, borrow with Max, LP deposit/withdraw/claim, swap, my position.
- [x] Hosting files: `docker/services.Dockerfile`, `docker-compose.testnet.yml` (not built yet: no Docker on this laptop).

To do, in order:

- [x] `extras` (deployer, small blocks are enough). Faucet `0xb249…80c6`, router `0xcD79…4fac`, NaiveLiquidator `0x8726…A84F`.
- [x] Market maker: API wallet `0x567e…` for your main account `0xa0bb…` (unified account, ~$30 free margin, long ~0.9 NVDA). Quotes 0.5 NVDA ±0.4%, capped at 1.5 NVDA either way. One tick tested: book now 210.65 / 212.35 around a 211.50 oracle.
- [ ] **You:** `0xa0bb…`'s 0.319 HYPE → Transfer to EVM → send ~0.25 to the faucet on HyperEVM (testers' gas; the faucet has 0.02). An API wallet can't send to other addresses.
- [x] Deep pool 150 USDC ±5%, thin pool 20 USDC, vault +100 (idle 146), faucet 40 USDC + 5 NVDAx + 0.02 HYPE (drip 0.1 NVDAx / 5 USDC / 0.002 HYPE), NaiveLiquidator 30, deployer keeps ~83. Faucet operator `0x5bd5…` allowed, 0.01 HYPE.
- [x] Everything runs in Docker: `pnpm testnet:up` / `testnet:logs` / `testnet:down` (keeper, risk engine, API, bots, web on :3000).
- [x] Unwinds while the stock market is closed, only when every rule passes: pool within 1.5% of HyperCore, ≤ 0.5% impact, ≤ 1% slippage (vault), and an ask on HyperCore for the buy-back (keeper's liquidity gate, market maker posts it on request, and only while its own liquidation price stays ≥ 8% away). Otherwise it waits. `cooldownClosedSec` = 30 s.
- [x] Explorer: our own `/tx/<hash>` page (HyperEVM testnet has no working public explorer): decoded call, events, and the vault's HyperCore fills. Every tx on the dashboard and /try links to it.
- [x] /try "What happened to your loan": liquidation → short on HyperCore → confirmed → unwinds, each with its tx.
- [x] A tester run through `/try`: faucet → collateral → Max borrow → liquidated and hedged within ~1 min (0x4d21…, tx 0x4988…).
- [ ] Second tester run end to end with the new timeline and tx pages (faucet cooldown is 10 min for now).
- [ ] Private RPC, server (`docker-compose.testnet.yml`), web on Vercel, real `REPLAY_TOKEN`, `ALERT_WEBHOOK_URL`.
- [ ] Full presenter run on testnet: `setup` → `scene` → `marketA` → `marketB` → `marketC` → `monday`.

- ✅ **Done when:** it behaves the same as the local run.

### 8. Tiny mainnet test

- [ ] Put $20–50 on xyz:NVDA from the deployed vault.

- [ ] Open one short, then close it.

- ✅ **Done when:** the tx hashes and fills are saved to show judges.

### 9. Ship

- [ ] Record a backup video.

- [ ] Write the README with diagrams.

- [ ] Make the slides.

**If you're on a team:** one person takes steps 2–3, which need the network. Another takes steps 4–6, which only need the local stack.

I can save this as `TODO.md` in the repo so you can tick the boxes as you go.