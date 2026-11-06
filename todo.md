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

- [ ] Run Deploy, CreateMarkets and SeedPool.

- [ ] Fund the hedge account.

- [ ] Point the keeper at testnet.

- [ ] Trigger one liquidate → syncHedge.

- ✅ **Go:** a short opens on Core and the vault reads it back.
- ❌ **No-go:** show the simulator in the Afterbell column instead.

### 4. API collector (local stack, can run alongside 2–3)

- [ ] Every second, read the 3 Morpho markets, the vault fields and the pool price in one multicall.

- [ ] Fetch `clearinghouseState` with `dex: "xyz"`.

- [ ] Collect vault events for the activity feed.

- ✅ **Done when:** the collector's values match `cast call` results against anvil.

### 5. Replay steps

- [ ] `setup`

- [ ] `scene` (set all 3 oracles)

- [ ] `marketA` (NaiveLiquidator)

- [ ] `marketC` (trigger keeper ticks)

- [ ] `monday` (deep pool, market-open flag, unwind loop)

- [ ] Connect `POST /replay/:step` to them.

- ✅ **Done when:** all the steps run in order on a fresh anvil without errors.

### 6. Dashboard on live data (local)

- [ ] Connect the dashboard to the collector.

- [ ] Run the full demo on anvil 3 or more times in a row.

- ✅ **Done when:** the hedge ratio dips to 0% and snaps back to 100% on every run.

### 7. Full demo on testnet

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