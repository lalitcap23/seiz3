# Afterbell: system architecture

Oct 18, 2026 · @green apple

## System at a glance

Afterbell is one money-holding contract (`AfterbellVault`) on HyperEVM that buys seized stock collateral from a Morpho market, shorts the same stock on HyperCore in the same transaction, and later sells the stock into Uniswap v4 while closing the short in step. Everything else either feeds it prices, pokes its public functions, or shows what it is doing.

&#91;embedded content: Afterbell system context · 3 layers, 11 components\]

Read it top down: off-chain processes only call or read; every arrow that moves money starts or ends at the vault, and HyperCore is reached only through CoreWriter (writes) and the precompiles (reads).

This doc turns the [PRD](https://claude.ai/code/artifact/0f189994-0b56-44ec-ba08-508ad64d9357) into a buildable design: what each component is, the exact calls between them, the state each one keeps, and the order to build them in. Anything marked **verify** is an assumption to prove in a pre-kickoff spike, not a fact.

The system has three layers:

1. **On-chain, HyperEVM (Solidity).** The vault, its hedge and unwind libraries, the risk config, the Morpho Blue market, the mock stock token and oracle, and the Uniswap v4 pool. These are the only things that hold or move money.
2. **On-chain, HyperCore (Hyperliquid's native exchange).** The vault's own trading account and its `xyz:NVDA` short. The vault reaches it only through two doors: it *writes* with the CoreWriter system contract and *reads* with read precompiles.
3. **Off-chain (TypeScript).** The keeper bot that calls public functions on a schedule, a small indexer/API that turns chain state into JSON, the demo replay script, and the dashboard judges watch. None of these hold keys to vault funds; the keeper only pays gas.

The one rule that shapes the whole design: **a HyperCore order sent from the EVM lands a few seconds later, returns nothing, and can be silently dropped.** So every write to HyperCore is followed by a separate read in a later transaction (`syncHedge`), and the vault tracks "sent" and "confirmed" sizes separately.

## Components

There are eleven components; only `AfterbellVault` holds LP money, and only the vault's own address trades on HyperCore.

| Component | Layer | What it owns or does | Talks to | Owner |
| --- | --- | --- | --- | --- |
| `AfterbellVault` | HyperEVM | ERC-4626 vault in USDC. Holds idle USDC and NVDAx inventory, owns the HyperCore trading account (same address), enforces risk checks and the hedge invariant | Morpho (liquidate + callback), CoreWriter (writes), read precompiles (reads), Uniswap v4 PoolManager (swaps), CoreDepositWallet (USDC to Core) | Contracts |
| `HedgeLib` | HyperEVM (library) | Encodes CoreWriter actions (limit order, USD class transfer, spot send), reads position, oracle price and asset info, converts sizes and prices to Core units | CoreWriter, precompiles (through hyper-evm-lib) | Contracts |
| `UnwindLib` | HyperEVM (library) | Sells one chunk of NVDAx into the v4 pool via `unlock` → `unlockCallback`, enforces `minAmountOut` | Uniswap v4 PoolManager | Keeper/integration |
| `RiskParams` | HyperEVM | Owner-set caps: max size, leverage, buffer, max unhedged, slippage, oracle band, retries | Read by the vault | Contracts |
| Morpho Blue market | HyperEVM | NVDAx collateral, USDC loans, 77% LLTV. Calls the vault back mid-liquidation | `DemoOracle`, vault callback | Contracts (deploy only) |
| `MockNVDAx` | HyperEVM | ERC-20 test stock token, owner-mintable | Morpho, v4 pool, vault | Contracts |
| `DemoOracle` | HyperEVM | Morpho-format price (scaled 1e36) the demo can move with `setPrice` | Morpho, vault (oracle-band check) | Contracts |
| Uniswap v4 NVDAx/USDC pool | HyperEVM | The slow exit for inventory; we seed it | Vault (swaps), replay script (seeding) | Keeper/integration |
| HyperCore account + `xyz:NVDA` short | HyperCore | Perp margin and the hedge position, isolated margin on the `xyz` DEX | Driven only by CoreWriter from the vault | Keeper/integration (setup) |
| Keeper bot | Off-chain (TS) | Watches Morpho positions and vault state; calls `liquidate`, `syncHedge`, `unwindStep`, `topUpMargin`. Pays gas, holds no vault funds | HyperEVM RPC, Hyperliquid info API (read only) | Keeper/integration |
| Indexer/API + dashboard | Off-chain (TS + React) | Turns chain events and precompile reads into JSON; renders the three-market replay, the live Hyperliquid position panel and the hedge strip | HyperEVM RPC, Hyperliquid info API, replay script | Frontend/pitch |

Two contracts that are *not* ours but sit in the path: the **CoreWriter** system contract at `0x3333…3333` and Circle's **CoreDepositWallet** that moves USDC from HyperEVM into HyperCore.

## Repo layout and tech stack

Use one monorepo with a Foundry project for contracts and a pnpm workspace for everything TypeScript, so ABIs and addresses flow from one `deployments/*.json` file into every off-chain package.

```
afterbell/
├─ contracts/                  # Foundry
│  ├─ src/
│  │  ├─ AfterbellVault.sol      # ERC-4626 + liquidate/callback/sync/unwind
│  │  ├─ RiskParams.sol
│  │  ├─ libs/HedgeLib.sol       # CoreWriter encode + precompile reads
│  │  ├─ libs/UnwindLib.sol      # Uniswap v4 swap via unlock callback
│  │  └─ mocks/MockNVDAx.sol, DemoOracle.sol, NaiveLiquidator.sol
│  ├─ script/Deploy.s.sol, SeedPool.s.sol, CreateMarkets.s.sol
│  └─ test/unit/, test/sim/ (hyper-evm-lib CoreSimulator), test/fork/
├─ packages/
│  ├─ shared/      # generated ABIs (wagmi cli), addresses, unit converters
│  ├─ keeper/      # Node + viem, the bot
│  ├─ api/         # small indexer + REST/SSE for the dashboard
│  ├─ replay/      # scripted 3-market demo
│  └─ web/         # React + Vite dashboard
└─ deployments/  # testnet.json, mainnet.json written by Deploy.s.sol
```

| Concern | Choice | Why |
| --- | --- | --- |
| Contracts | Solidity 0.8.x, Foundry | Fast tests, fork mode, the HyperCore simulator ships as a Foundry lib |
| HyperCore access | [hyper-evm-lib](https://github.com/hyperliquid-dev/hyper-evm-lib) (`CoreWriterLib`, `PrecompileLib`, test engine) | Typed action encoders, decimal converters, local simulation of precompiles and CoreWriter |
| Vault base | OpenZeppelin `ERC4626` with a decimals offset | Battle-tested share math and first-deposit inflation protection |
| Lending | Morpho Blue (`IMorpho`, `IMorphoLiquidateCallback`) | Liquidation callback lets us hedge before paying |
| DEX | Uniswap v4 core + periphery | Unwind venue; strongest sponsor fit |
| Off-chain | TypeScript, viem, pnpm | One language for keeper, API, replay and UI |
| Hyperliquid reads off-chain | Public info API (`clearinghouseState` with `dex: "xyz"`, `metaAndAssetCtxs`) | Dashboard panel and cross-checking the precompile view |
| UI | React, Vite, TanStack Query, a chart lib | Polls the API every 1–2 s |

HyperEVM has [two block types](https://docs.chainstack.com/docs/hyperliquid-corewriter): fast blocks (about 1 s, 3M gas) and slow big blocks (about 1 min, 30M gas). Deploying the vault will likely need big blocks, so flip the deployer into big-block mode before `forge script` and back afterwards; keep runtime calls under the small-block limit.

## AfterbellVault internals

The vault is one contract with four jobs: LP bookkeeping, buying collateral, keeping the hedge matched, and unwinding. Keep it one contract (with libraries) so the HyperCore account and the funds share one address.

**Storage layout**

```solidity
// immutable wiring
IERC20  public immutable usdc;          // 6 decimals on HyperEVM
IERC20  public immutable nvdax;         // 18 decimals (MockNVDAx)
IMorpho public immutable morpho;
IPoolManager public immutable poolManager;   // Uniswap v4
PoolKey public poolKey;                       // NVDAx/USDC pool
uint32  public immutable perpAsset;     // xyz:NVDA = 100000 + dexIndex*10000 + indexInMeta
uint32  public immutable perpDexIndex;  // index of the xyz DEX
RiskParams public risk;

// position state
uint256 public inventory;        // NVDAx held, 18 dec
int64   public confirmedShort;   // perp size read from the precompile (Core units, negative = short)
struct Pending { int64 delta; uint64 sentBlock; uint64 sentAt; uint8 tries; }
Pending public pendingHedge;     // last order sent but not yet seen
uint256 public marginFloat;      // USDC we believe sits on the xyz perp account (refreshed on sync)
bool    public paused;
uint64  public lastUnwindAt;

// LP state
uint256 public queuedShares;     // shares waiting in the withdrawal queue
mapping(address => uint256) public queued;

// reentrancy / callback guard (transient storage)
bool transient inLiquidation;
```

**Function spec**

| Function | Caller | What it does | Reverts when |
| --- | --- | --- | --- |
| `deposit` / `mint` | LP | Standard ERC-4626 USDC in, shares out | `paused` (optional) |
| `requestWithdraw(shares)` | LP | Pays at once from idle USDC; otherwise locks shares in the queue | shares > balance |
| `claimQueued()` | LP | Pays queued shares once idle USDC frees up after unwinds | nothing to claim |
| `totalAssets()` | anyone (view) | Idle USDC + Core USDC + inventory × oracle + perp uPnL (see LP accounting) | precompile failure |
| `liquidate(params, borrower, seized)` | keeper (anyone) | Runs pre-checks, sets `inLiquidation`, calls `morpho.liquidate(params, borrower, seized, 0, data)` | paused, hedge pending, over cap, low margin, oracle band broken |
| `onMorphoLiquidate(repaid, data)` | Morpho only | Books inventory, checks the discount, sends the IOC short through CoreWriter, records `pendingHedge`, approves USDC for Morpho to pull | caller ≠ Morpho, `inLiquidation` false, discount below floor |
| `syncHedge()` | keeper (anyone) | Reads the position precompile, updates `confirmedShort`, re-sends any gap within the price cap, pauses after N tries | called in the same block the order was sent |
| `unwindStep()` | keeper (anyone) | Sells one chunk into v4 with a `minAmountOut`, then queues a reduce-only buy of the same size | hedge pending, cooldown not elapsed, oracle gap too wide, inventory 0 |
| `topUpMargin(amount)` | keeper (anyone) | Moves idle USDC into the perp account through CoreDepositWallet | amount > idle, account would go below withdrawal reserve |
| `setRisk`, `pause`, `unpause`, `rescue` | owner | Admin for the hackathon | not owner |

**Rules baked into the code**

- **One hedge in flight.** `liquidate` and `unwindStep` refuse while `pendingHedge.delta != 0`. This keeps the accounting simple: there is never more than one unconfirmed order.
- **Invariant.** After every `syncHedge`, `|inventoryInCoreUnits + confirmedShort| ≤ maxUnhedged`. While an order is pending, the check uses `confirmedShort + pendingHedge.delta`.
- **Chunk ≤ maxUnhedged.** `unwindStep` sells stock before the reduce-only buy lands, so the vault is briefly over-hedged by one chunk. Capping the chunk at `maxUnhedged` keeps that window inside the invariant.
- **Discount floor.** In the callback, require `repaid ≤ seized × oraclePrice × (1 − minDiscount)`. Morpho sets the bonus from LLTV (about 7.4% at 77%), so this is a guard against a mispriced market, not the source of the discount.
- **Callback guard.** Only accept `onMorphoLiquidate` when `msg.sender == morpho` *and* the transient `inLiquidation` flag is set, so nobody can trigger a hedge order from outside a real liquidation.

**Units you will convert all day**

| Quantity | Where | Units |
| --- | --- | --- |
| USDC on HyperEVM | ERC-20 | 6 decimals |
| NVDAx | ERC-20 | 18 decimals |
| Morpho oracle price | `IOracle.price()` | 1e36 scaled, adjusted for token decimals |
| CoreWriter `limitPx`, `sz` | action 1 | human value × 10^8, rounded to the asset's `szDecimals` and tick rules |
| Oracle precompile price | `oraclePx(asset)` | divide by 10^(6 − szDecimals) for perps |
| Position size `szi` | position precompile | signed, in Core size units |

Put every conversion in one `Units` library with unit tests; most CoreWriter orders that silently vanish are a rounding or scaling bug.

## Talking to HyperCore

The vault touches HyperCore through three doors: CoreWriter to write, read precompiles to read, and CoreDepositWallet to move USDC in. Each has one behaviour that will bite if you forget it.

**1. Writes: CoreWriter**

CoreWriter is a system contract at `0x3333333333333333333333333333333333333333` with one function, `sendRawAction(bytes)`. It burns about 25,000 gas, emits a log, and [HyperCore processes the queued actions after the EVM block finishes](https://web3-ethereum-defi.readthedocs.io/api/hyperliquid/_autosummary_hyperliquid/eth_defi.hyperliquid.core_writer.html); order actions are further [delayed a few seconds](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/evm/system-contract). The action runs as the calling contract's own HyperCore account. The EVM transaction succeeds whether or not HyperCore accepts the action.

Payload = 1 version byte (`0x01`) + 3-byte big-endian action id + `abi.encode(params)`:

```solidity
function _limitOrder(uint32 asset, bool isBuy, uint64 px, uint64 sz, bool reduceOnly, uint128 cloid) internal {
    bytes memory params = abi.encode(asset, isBuy, px, sz, reduceOnly, uint8(3) /* IOC */, cloid);
    bytes memory data = abi.encodePacked(uint8(1), uint24(1) /* limit order */, params);
    ICoreWriter(0x3333333333333333333333333333333333333333).sendRawAction(data);
}
```

| Action id | Name | Params | Afterbell uses it for |
| --- | --- | --- | --- |
| 1 | Limit order | `(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 tif, uint128 cloid)`; tif 1 = Alo, 2 = Gtc, 3 = Ioc | Opening the short (sell, IOC, price floor = oracle − 1%) and reducing it (buy, reduce-only, IOC, price cap = oracle + 1%) |
| 6 | Spot send | `(address dest, uint64 token, uint64 wei)` | Pulling USDC back to HyperEVM by sending to the system address `0x2000…0000` |
| 7 | USD class transfer | `(uint64 ntl, bool toPerp)` | Moving USDC between spot and perp balances |
| 13 | Send asset | see docs | Possibly needed to move USDC to the `xyz` DEX's isolated margin (**verify**, open question 2) |

Use a `cloid` on every order (for example `keccak(liquidationId, try)` truncated to 128 bits). It lets the dashboard and keeper match a CoreWriter order to its fill in the Hyperliquid info API.

**2. Reads: precompiles**

Read precompiles start at `0x…0800`. Each address is one query; calldata is the raw ABI-encoded arguments with no function selector. They return HyperCore state as of when the EVM block was built, so you can never see the result of a CoreWriter action in the same transaction. A call with an invalid asset or address reverts and consumes all gas given to it, so wrap reads in a gas-limited `staticcall`.

| Address | Read | Afterbell uses it in |
| --- | --- | --- |
| `0x…0800` | `position(user, perp)` → `szi`, entry notional, isolated margin, leverage | `syncHedge`, `totalAssets` |
| `0x…0807` | `oraclePx(asset)` | Oracle band check, order price caps, `totalAssets` |
| `0x…080a` | `perpAssetInfo(asset)` → `szDecimals` | Constructor / `Units` |
| `0x…080f` | account margin summary (per perp DEX) | `marginFloat`, liquidation pre-check (**verify** signature) |
| `0x…0810` | `coreUserExists(user)` | Setup check that the vault's Core account is live before any action |

**3. Money in and out**

- **HyperEVM → HyperCore.** Approve USDC to Circle's [CoreDepositWallet](https://developers.circle.com/cctp/howtos/transfer-usdc-from-hyperevm-to-hypercore) and call `deposit(amount, destinationDex)`; `0` credits perps, `4294967295` credits spot. Whether a non-zero index can credit the `xyz` DEX directly is part of open question 2.
- **HyperCore → HyperEVM.** CoreWriter spot send (action 6) to the USDC system address `0x2000000000000000000000000000000000000000`.
- **Account activation.** A new HyperCore account must already exist before it sends actions; funding it in the same block does not work. Circle notes a one-time 1 USDC activation fee. So deposit a few USDC from the vault in the deploy script, wait for `coreUserExists`, then move margin to perp. On mainnet this works (a new depositor's ledger shows `accountActivationGas` 1 USDC, then the credit). Testnet's CoreDepositWallet never credits HyperCore at all (spike 2a/2b), so on testnet the vault is activated and funded with a HyperCore-side USDC send instead.

**HIP-3 specifics for `xyz:NVDA`**

- Asset id = `100000 + perpDexIndex × 10000 + indexInMeta` ([asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)). Read `perpDexIndex` and `indexInMeta` from the info API (`perpDexs`, `meta` with `dex: "xyz"`) once and store them as immutables.
- Each HIP-3 DEX has [independent margining and isolated-only margin](https://hyperliquid.gitbook.io/Hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals), so margin must sit on the `xyz` DEX, not the main perp balance.
- **Verify** that the position precompile can address a HIP-3 asset. The original `L1Read` signature takes a `uint16` perp index, and HIP-3 ids are above 100,000. If it cannot, read the position through the margin-summary precompile or whatever hyper-evm-lib exposes for builder DEXs.

## Liquidation flow

A liquidation is two transactions: one that buys the collateral and sends the short, and a second, seconds later, that confirms the short actually filled. Lenders are made whole in the first; the vault is fully hedged only after the second.

&#91;embedded content: Liquidation sequence · 2 transactions, 5 participants\]

The accent arrow is the only HyperCore write in Tx 1. Morpho has already sent the collateral when it calls back, and pulls USDC only after the callback returns.

**Transaction 1: `keeper → vault.liquidate(...)`**

1. **Keeper picks a target.** It reads each borrower's collateral and borrow shares from Morpho, prices them with `DemoOracle`, and finds one with LTV above LLTV. It sizes `seized = min(collateral, maxLiquidation / price)` and simulates the call with `eth_call` first.
2. **Vault pre-checks.** Not paused; no hedge in flight; `seized × price ≤ maxLiquidation`; `marginFloat ≥ notional / leverage × (1 + buffer)`; lending oracle and `oraclePx` within `oracleBandBps`. Any failure reverts before Morpho is touched.
3. **Vault calls Morpho.** Sets the transient `inLiquidation` flag and calls `morpho.liquidate(params, borrower, seized, 0, abi.encode(liqId))`.
4. **Morpho transfers collateral first.** It accrues interest, checks the borrower is unhealthy, works out `repaidAssets` from the liquidation incentive, and sends the seized NVDAx to the vault.
5. **Morpho calls back.** `vault.onMorphoLiquidate(repaidAssets, data)` runs while Morpho waits for payment. Inside it the vault:
   1. adds `seized` to `inventory`;
   2. checks the discount floor against the Core oracle price;
   3. converts `seized` to Core size, rounds to `szDecimals`, and sets the price floor at oracle − 1%;
   4. calls `HedgeLib.openShort` → `CoreWriter.sendRawAction` (sell, IOC, with a `cloid`);
   5. records `pendingHedge = {delta: −sz, sentBlock: block.number, sentAt: block.timestamp, tries: 1}`;
   6. approves Morpho for `repaidAssets` USDC.
6. **Morpho pulls USDC.** `transferFrom(vault, repaidAssets)`; the bad loan is closed and `Liquidate` is emitted.
7. **Vault finishes.** Clears `inLiquidation` and emits `LiquidationTaken(liqId, borrower, seized, repaid, sz, cloid)`.

**Between transactions (HyperCore, a few seconds).** After the EVM block ends, HyperCore picks up the queued action, waits out the order delay, and matches the IOC sell against the `xyz:NVDA` book. Whatever does not fill at or above the floor is cancelled.

**Transaction 2: `keeper → vault.syncHedge()`** (next section). The keeper waits until a later block and at least the order delay, then calls it. The dashboard shows the short appearing at this point.

If the IOC order is malformed (bad size rounding, wrong asset id, no margin on the `xyz` DEX), nothing reverts in transaction 1: lenders are still repaid, and `syncHedge` will find no position and retry. That is why the pre-checks matter more than the order code.

## Hedge confirmation

`syncHedge()` is the vault's only way to learn what HyperCore did. It compares what the vault wanted (`target = −inventory` in Core units) with what the position precompile says, and closes the gap or stops taking risk.

&#91;embedded content: Hedge state machine · 4 states, driven by syncHedge\]

Idle is the only state that allows new risk. Paused is left automatically once a sync finds the hedge matched and margin above the buffer; the owner's `unpause` is a manual override.

The hedge moves through four states:

| State | Meaning | Entered when | Allowed actions |
| --- | --- | --- | --- |
| `Idle` | `pendingHedge.delta == 0`, invariant holds | Sync confirms the fill | `liquidate`, `unwindStep`, `syncHedge` (no-op) |
| `Pending` | An order was sent, not yet seen | `onMorphoLiquidate` or `unwindStep` sends an order | Only `syncHedge`, and only in a later block |
| `Retrying` | Sync saw a partial or no fill; remainder re-sent | Gap > `maxUnhedged` and `tries < maxTries` | Only `syncHedge` |
| `Paused` | Could not hedge after `maxTries`, or margin too low | `tries == maxTries` or margin check fails | `syncHedge` keeps retrying; owner can `unpause` |

```solidity
function syncHedge() external {
    Pending memory p = pendingHedge;
    require(block.number > p.sentBlock, "same block");
    require(block.timestamp >= p.sentAt + risk.orderDelaySec, "too early");

    int64 actual = HedgeLib.position(address(this), perpAsset);   // signed szi
    confirmedShort = actual;
    int64 target = -Units.toCoreSize(inventory);
    int64 gap = target - actual;                                 // <0: need more short, >0: over-short

    if (_abs(gap) <= risk.maxUnhedged) {                         // hedged
        delete pendingHedge;
        if (_marginOk()) paused = false;                         // self-recovery
        emit HedgeConfirmed(actual, target);
        return;
    }
    if (p.tries >= risk.maxTries) { paused = true; emit HedgeStuck(gap); }

    uint64 px = HedgeLib.oraclePx(perpAsset);
    bool isBuy = gap > 0;                                       // over-short → buy back
    uint64 limit = isBuy ? px * (10_000 + risk.hedgeCapBps) / 10_000
                         : px * (10_000 - risk.hedgeCapBps) / 10_000;
    HedgeLib.limitOrder(perpAsset, isBuy, limit, _abs(gap), /*reduceOnly*/ isBuy, _cloid(p.tries + 1));
    pendingHedge = Pending(gap, uint64(block.number), uint64(block.timestamp), p.tries + 1);
}
```

Three details that matter:

- **The target comes from inventory, not from the last order.** Sync always aims at `−inventory`, so a missed liquidation order, a missed unwind order and a double fill all heal the same way.
- **Sync also refreshes margin.** Read the margin summary in the same call, update `marginFloat`, and set `paused` if the short's margin ratio is below the buffer; the keeper then calls `topUpMargin`.
- **Paused still syncs.** Pausing stops *new* risk (`liquidate`, `unwindStep`), never the retry loop, so the vault can recover on its own when the book refills.

## Unwind flow

Each `unwindStep()` sells one small chunk of NVDAx into the Uniswap v4 pool and queues a reduce-only buy of the same size on the perp, so stock and short shrink together. Anyone can call it; the contract decides whether it is allowed.

&#91;embedded content: Unwind loop · one chunk per call until inventory is zero\]

The two accented steps are the matched pair: stock leaves the vault on Uniswap, and the same size of short is bought back on HyperCore, so the vault stays neutral through the whole unwind.

**Guards, in order**

1. `pendingHedge.delta == 0` (the last order was confirmed).
2. `block.timestamp ≥ lastUnwindAt + cooldown`, where `cooldown` is shorter when the stock market is open. For the demo, read market hours from a flag the owner (or replay script) sets; a production version would use the oracle's market-status field.
3. Pool price within `oracleBandBps` of `oraclePx`. If the token trades away from the perp, wait: the hedge holds the value.
4. `inventory > 0`.

**Chunk size**

`chunk = min(inventory, maxUnhedged, sizeForImpact(0.5%))`. For a v4 pool, the size that moves price by at most 0.5% can be read off the pool's current liquidity and `sqrtPriceX96` (or estimated off-chain by the keeper and passed in, then re-checked on-chain by `minAmountOut`).

**The swap (v4 flash accounting)**

v4 swaps from a contract go through `PoolManager.unlock`, which calls back into your contract:

```solidity
function unwindStep() external {
    _checkUnwindGuards();
    uint256 chunk = _chunkSize();
    uint256 minOut = _quote(chunk) * (10_000 - risk.maxSlippageBps) / 10_000;
    uint256 usdcOut = abi.decode(poolManager.unlock(abi.encode(chunk, minOut)), (uint256));

    inventory -= chunk;
    lastUnwindAt = uint64(block.timestamp);
    int64 sz = Units.toCoreSize(chunk);
    HedgeLib.limitOrder(perpAsset, true, _pxCap(), uint64(sz), /*reduceOnly*/ true, _cloid(0));
    pendingHedge = Pending(sz, uint64(block.number), uint64(block.timestamp), 1);
    emit Unwound(chunk, usdcOut);
}

function unlockCallback(bytes calldata data) external returns (bytes memory) {
    require(msg.sender == address(poolManager));
    (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));
    BalanceDelta d = poolManager.swap(poolKey, SwapParams({
        zeroForOne: nvdaxIsCurrency0, amountSpecified: -int256(amountIn),
        sqrtPriceLimitX96: _limitFor(nvdaxIsCurrency0)}), "");
    // settle what we owe (NVDAx), take what we're owed (USDC)
    _settle(nvdax, amountIn);
    uint256 out = _take(usdc);
    require(out >= minOut, "slippage");
    return abi.encode(out);
}
```

The stretch goal from the PRD (a v4 hook that fills buyers from vault inventory at the oracle price) plugs in here later: it would let organic buyers pull inventory instead of the vault pushing it.

**Settle.** When `inventory == 0` and the last sync confirms the short is zero, the perp account holds only USDC. The keeper (or anyone) calls `withdrawMargin(amount)`, which sends USDC back to HyperEVM with spot send (action 6) to the system address. Arrival is asynchronous, so the next `syncHedge` or a `claimQueued` call notices the new idle balance and pays the withdrawal queue.

## LP accounting

Share price = `totalAssets / totalSupply`, and `totalAssets` counts every place the vault's value sits, on both sides of the bridge.

&#91;embedded content: Money and stock flows · USDC and NVDAx through the vault\]

USDC leaves idle balance three ways (repaying Morpho, funding margin, paying LPs) and returns two ways (pool proceeds, margin sent back). `totalAssets` must count each box, including money in transit between HyperEVM and HyperCore.

```latex
\text{totalAssets} = \text{USDC}_{\text{EVM idle}} + \text{USDC}_{\text{Core}} + \text{inventory} \times P_{\text{oracle}} + \text{uPnL}_{\text{perp}} + \text{USDC}_{\text{in transit}}
```

| Term | Read from | Note |
| --- | --- | --- |
| Idle USDC | `usdc.balanceOf(vault)` | Pays instant withdrawals |
| Core USDC | Margin summary precompile (account value on the `xyz` DEX plus any spot balance) | Already includes uPnL if you read account value; then drop the separate uPnL term to avoid double counting |
| Inventory value | `inventory × oraclePx` | Use the Core oracle, the same price the hedge marks against, so stock and short net to near zero |
| In transit | Vault storage: amount sent to or from Core but not yet visible | Without this, share price dips for a few seconds on every margin move |

**Deposits.** Plain ERC-4626. Use OpenZeppelin's decimals offset (for example 6) so the first-depositor inflation attack is not worth doing. Seed the vault with a small deposit in the deploy script.

**Withdrawals.** `maxWithdraw` is capped at idle USDC minus a reserve kept for margin top-ups. Larger requests call `requestWithdraw(shares)`: the shares move into the vault (`queued[lp] += shares`) and their USDC value is fixed at the next settle, not at request time, so queued LPs keep sharing gains and losses until they are paid. `claimQueued()` burns them and pays out once unwinds free cash.

**Why LP returns are direction-neutral.** If NVDA falls 10% mid-unwind, inventory value falls by the same dollars the short gains, so `totalAssets` barely moves. What LPs earn is the liquidation bonus minus perp fees, funding paid while short, pool slippage and gas. The worked example in the PRD is about $0.69M gross on a $10M liquidation.

## Keeper bot

The keeper is a single Node process with one tick loop. It never decides anything the contract does not re-check: its job is to call public functions at the right moment and stop calling when they would revert.

**Tick (every 1 s, one action per tick, priority order)**

| Priority | Condition read | Call | Notes |
| --- | --- | --- | --- |
| 1 | `pendingHedge.delta != 0` and `now ≥ sentAt + orderDelay` and `block > sentBlock` | `syncHedge()` | Always first: an unconfirmed hedge blocks everything else |
| 2 | Margin ratio below buffer (precompile or info API) | `topUpMargin(amount)` | Amount = what restores buffer + 10% |
| 3 | A Morpho position with LTV > LLTV and the vault is idle | `liquidate(params, borrower, seized)` | Simulate with `eth_call` first; skip if it would revert |
| 4 | `inventory > 0`, cooldown elapsed, pool within band | `unwindStep()` | Cooldown shorter during market hours |
| 5 | `inventory == 0`, short == 0, Core USDC above reserve | `withdrawMargin(amount)` | Returns cash for the withdrawal queue |

**Finding liquidatable borrowers.** For the demo there are a handful, so keep a static list from the replay script. A general version subscribes to Morpho `SupplyCollateral` and `Borrow` events for the market id, keeps a borrower set, and recomputes health each tick with `collateral × price / 1e36 × LLTV < borrowAssets`.

**Transaction hygiene**

- One signer, one nonce manager, and never two transactions in flight; HyperEVM fast blocks are about 1 s, so waiting for each receipt costs little.
- Gas limit per call stays under the 3M small-block cap; add a fixed margin over `estimateGas` because precompile calls are hard to estimate.
- Every revert reason is logged with the tick's input state, which makes debugging at 3 a.m. at the venue tolerable.

**What it reads from Hyperliquid off-chain.** `clearinghouseState` with `dex: "xyz"` for the vault address, to cross-check the precompile, and `orderStatus` by `cloid` for the dashboard. The keeper never signs Hyperliquid API orders; every order comes from the vault through CoreWriter.

**Replay mode.** The same binary accepts `--replay`, which lets the replay script advance a fake clock (market open/closed) and trigger ticks on demand so the 3-minute demo is deterministic.

## Indexer, API and dashboard

The dashboard never talks to the chain directly; a small API process polls HyperEVM and Hyperliquid once a second, keeps the latest snapshot in memory, and pushes it to the browser over Server-Sent Events. One source of truth makes the three columns move in sync on stage.

**What the API collects each second**

- From HyperEVM (one `multicall`): for each of the three Morpho markets, total borrow, total collateral, the demo borrower's position, and bad debt (from `Liquidate` events' `badDebtAssets`); from the vault, `inventory`, `confirmedShort`, `pendingHedge`, `paused`, `totalAssets`, `totalSupply`; the v4 pool's `slot0` price.
- From Hyperliquid info API: `clearinghouseState` (`dex: "xyz"`) for the vault address, and the `xyz:NVDA` mark and oracle price.
- From vault events (`LiquidationTaken`, `HedgeConfirmed`, `HedgeStuck`, `Unwound`): an activity feed with timestamps and `cloid`s.

| Endpoint | Returns | Used by |
| --- | --- | --- |
| `GET /snapshot` | Full current state as JSON | First page load |
| `GET /stream` (SSE) | The same snapshot every second, plus events as they happen | Live updates |
| `GET /history?from=` | Time series of inventory, short, hedge ratio, share price | Strip charts |
| `POST /replay/:step` | Triggers the next scripted demo step (guarded by a token) | Presenter's clicker |

**Screen layout (from the demo script)**

1. Three columns, Market A naive, Market B conservative, Market C Afterbell: debt, collateral value, LTV, bad debt (red when non-zero).
2. A Hyperliquid panel: the vault's `xyz:NVDA` position size, entry, uPnL, margin, and a link to the vault address on a Hyperliquid explorer so judges can see it is real.
3. A strip along the bottom: inventory bar, short bar, hedge ratio (`|short| / inventory`, green within `maxUnhedged`), LP share price.

Show the hedge ratio as the hero number: a judge should see it dip to 0% for a few seconds after the click, then snap to 100% when `syncHedge` lands.

## Demo replay orchestration

The replay is a TypeScript script that drives scripted on-chain actions step by step from a clicker, so the same 3-minute story plays identically every time; only the Afterbell hedge touches a market we don't control.

**Setup (run once, before judging)**

1. Deploy `MockNVDAx`, three `DemoOracle` instances and three Morpho markets. Morpho identifies a market by its parameters, so give each market its own oracle address; otherwise A and C (same tokens, same LLTV) collapse into one market.
2. Market A and C: LLTV 77%. Market B: a low LLTV such as 38.5% (**verify** which LLTVs are enabled on Morpho's HyperEVM deployment).
3. Supply USDC to each market as a lender; create one borrower per market with the same NVDAx collateral, each borrowing close to its limit.
4. Seed the v4 NVDAx/USDC pool **thin** (weekend conditions), deposit LP USDC into `AfterbellVault`, and fund its HyperCore margin.

**Show (each row is one click)**

| Beat | Script does | What judges see |
| --- | --- | --- |
| Scene | Sets all three oracles to the drop price at once | All three borrowers turn red |
| Market A, naive | `NaiveLiquidator` seizes collateral and dumps it into the thin pool; proceeds fall short of the debt (see below) | Bad debt in red under column A |
| Market B, conservative | Nothing to liquidate: the borrower is still healthy | No bad debt, but a borrow limit of about 40% |
| Market C, Afterbell | Keeper calls `vault.liquidate`; then `syncHedge` | Lenders repaid at once; hedge ratio 0% → 100%; the short appears in the Hyperliquid panel |
| Monday | Adds deep liquidity to the pool (makers return), flips the market-open flag, runs `unwindStep` in a loop | Inventory and short shrink together; share price ticks up |

For Market A, decide before the event how bad debt is made visible. One straightforward way: `NaiveLiquidator` liquidates in Morpho's callback, swaps the seized collateral for whatever the thin pool pays, and tops up the shortfall from its own balance so the transaction succeeds; the dashboard then reports the shortfall as "bad debt the lenders would have eaten". This keeps the contract simple and the story honest.

Record the whole run as a backup video at hour 30–34, as the PRD plans.

## Failure modes and safety

Every failure resolves to one of two vault responses: refuse new risk (`paused`, or a pre-check revert) or keep the existing hedge and wait. The vault never sells stock unhedged and never opens a short without stock behind it.

| Failure | Detected by | Vault response | Keeper response | Dashboard |
| --- | --- | --- | --- | --- |
| CoreWriter order dropped (bad rounding, wrong asset, no margin) | `syncHedge` sees no change in `szi` | Retry within the price cap; pause after `maxTries` | Keeps calling `syncHedge` | Hedge ratio stuck below 100%, amber |
| Partial IOC fill (thin weekend book) | `syncHedge` gap > `maxUnhedged` | Re-send the remainder | Same | Ratio climbs in steps |
| NVDA rallies, short margin runs low | Margin summary in `syncHedge` | Sets `paused` until topped up | `topUpMargin` from idle USDC; if idle is empty, `unwindStep` raises cash | Margin bar turns red |
| Token price drifts from perp | Band check in `unwindStep` | Refuses to sell | Skips unwind, retries next tick | "Waiting for buyers" |
| Lending oracle disagrees with Core oracle | Band check in `liquidate` | Refuses the liquidation | Skips; logs | Nothing taken |
| Pool too thin | `minAmountOut` revert in the swap | Nothing sold | Backs off | Inventory flat, still hedged |
| Hyperliquid unreachable / precompile reverts | Gas-limited `staticcall` fails | Pre-checks fail closed, so no new liquidation | Alerts | Panel shows stale data badge |
| Keeper offline | Nobody calls functions | Nothing happens; state stays hedged | Anyone can call the same public functions | Last-update timestamp ages |
| Callback called from outside a liquidation | `msg.sender` and transient flag | Revert | n/a | n/a |
| First-depositor share inflation | Decimals offset + seed deposit | Attack unprofitable | n/a | n/a |

Risks that remain and should be said in the pitch: basis between NVDAx and the perp, funding paid while short, HyperCore venue risk, smart-contract risk, and the fact that real tokenized stocks are not on HyperEVM (open question 5).

## Testing strategy

Test in five rings, cheapest first; nothing moves to the next ring until the current one is green.

| Ring | Tool | What it proves | Key tests |
| --- | --- | --- | --- |
| 1. Unit | Foundry, mocked CoreWriter/precompiles | Math and guards | `Units` round-trips (6/18 dec ↔ 10^8 ↔ szDecimals); pre-check reverts; discount floor; callback guard; share math |
| 2. Simulator | hyper-evm-lib test engine | The vault's HyperCore account behaves | Liquidate → order queued → advance block → sync sees position; partial fill → retry; no fill × 3 → paused |
| 3. Fork | `forge test --fork-url` HyperEVM | Real Morpho and Uniswap v4 bytecode | Morpho liquidate with callback; v4 swap through `unlock`; full liquidate → unwind loop with the simulator for Core |
| 4. Testnet | HyperEVM testnet + HyperCore testnet | CoreWriter orders really land | Account activation; USDC to perp; one IOC order on a HIP-3 test market read back through the precompile |
| 5. Mainnet-tiny | $20–50 on `xyz:NVDA` | The demo leg | One short open and close from the deployed vault |

**Invariant (fuzz) tests worth writing in ring 2:** random sequences of `liquidate`, `syncHedge`, `unwindStep`, oracle moves and partial fills; after each `syncHedge`, assert `|inventory + short| ≤ maxUnhedged` or `paused == true`, and that `totalAssets` never moves by more than fees and slippage when only the price changes.

The simulator ring is where most bugs will surface; the testnet ring is where the remaining unknowns (open questions 2 and 3) get answered.

## Build order

Agree the interfaces in the first hour, then the three people build in parallel against mocks and meet at hour 18 and hour 24. The first real hedge by hour 12 stays the go/no-go point from the PRD.

**Interfaces to freeze at hour 0–1** (write them as Solidity interfaces and a TypeScript type in `packages/shared`)

| Interface | Between | Contents |
| --- | --- | --- |
| `IAfterbellVault` | Contracts → keeper, API | `liquidate`, `syncHedge`, `unwindStep`, `topUpMargin`, `withdrawMargin`, view getters for every state field |
| Vault events | Contracts → API | `LiquidationTaken`, `HedgeSent`, `HedgeConfirmed`, `HedgeStuck`, `Unwound`, `MarginMoved` with `cloid` where relevant |
| `deployments/<net>.json` | Deploy script → everyone | Addresses, Morpho market ids, pool key, `perpAsset`, `perpDexIndex`, `szDecimals` |
| Snapshot JSON | API → web | The shape `/snapshot` and `/stream` return; the frontend builds against a fixture of it from hour 1 |

**Who builds what, when**

| Hours | Contracts | Keeper and integration | Frontend and pitch |
| --- | --- | --- | --- |
| 0–4 | Repo, mocks, Morpho markets deployed | Vault Core account activated and funded; `deployments.json` | Snapshot fixture; three-column layout |
| 4–12 | `liquidate`, callback, `openShort` | Keeper skeleton, liquidate path | Hyperliquid panel from info API |
| 12 | **First real hedge lands** (go/no-go) |  |  |
| 12–18 | `syncHedge`, invariant, `unwindStep` | v4 pool seeding; unwind path in keeper | Strip charts from `/history` |
| 18–24 | Fuzz tests, fixes | Replay script, three-market setup | API process + SSE wired |
| 24–30 | Fixes from end-to-end runs | End-to-end runs | Dashboard on live data |
| 30–36 | Freeze | Rehearse, backup video | README with these diagrams, slides, submission |

If the hedge has not landed by hour 12, switch the demo to the simulator for the Afterbell column and show the testnet order separately, as the PRD says.

## Gotchas and pre-kickoff spikes

Six spikes before 4 Nov settle every **verify** in this doc; do them in throwaway repos, per ETHGlobal's from-scratch rule.

- [ ] **HIP-3 position read.** From a scratch contract, place one IOC order on a HIP-3 market via CoreWriter and read it back. Confirm which precompile and which index type address a HIP-3 asset id above 100,000.
- [ ] **Margin path to `xyz`.** Find the exact sequence that puts USDC on the `xyz` DEX's isolated margin: CoreDepositWallet with a DEX index, USD class transfer (action 7), or send asset (action 13).
- [ ] **Account activation.** Deploy a contract, deposit USDC, wait for `coreUserExists`, then send an action; confirm the 1 USDC activation fee behaviour.
- [ ] **Order delay.** Measure seconds from `sendRawAction` to the fill on testnet; set `orderDelaySec` and the keeper's wait from it.
- [ ] **Morpho on HyperEVM.** Confirm the Morpho Blue address, the enabled LLTVs (77% and a low one for Market B) and an enabled IRM, then run `liquidate` with a callback on a fork.
- [ ] **Uniswap v4 on HyperEVM.** Confirm the PoolManager address, create and seed a pool, and swap through `unlock` on a fork.

**Gotchas to keep on a sticky note**

- `sendRawAction` never reverts on a bad order. Read the position in a later block, always.
- You cannot read the result of a CoreWriter action in the same transaction; precompiles show state from when the block was built.
- A precompile called with a bad asset id eats all the gas you give it. Cap gas on every read.
- Perp orders spend the perp (and for HIP-3, the DEX's isolated) balance, not spot. A funded vault can still have every order dropped.
- Round size to `szDecimals` and price to the tick rules before scaling by 10^8.
- Deploy large contracts in big blocks; keep runtime calls under 3M gas.
- Give each demo Morpho market its own oracle address or two of them become the same market.

## Sources

- [Afterbell: PRD and architecture](https://claude.ai/code/artifact/0f189994-0b56-44ec-ba08-508ad64d9357)
- [Hyperliquid docs: CoreWriter and read precompiles](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/evm/system-contract)
- [Hyperliquid docs: interacting with HyperCore](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)
- [Hyperliquid docs: HIP-3 builder-deployed perpetuals](https://hyperliquid.gitbook.io/Hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals)
- [Hyperliquid docs: asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)
- [Chainstack: CoreWriter guide](https://docs.chainstack.com/docs/hyperliquid-corewriter)
- [Chainstack: bridging USDC between HyperCore and HyperEVM](https://docs.chainstack.com/docs/hyperliquid-bridging-usdc)
- [Circle: transfer USDC from HyperEVM to HyperCore](https://developers.circle.com/cctp/howtos/transfer-usdc-from-hyperevm-to-hypercore)
- [eth\_defi: CoreWriter encoding reference](https://web3-ethereum-defi.readthedocs.io/api/hyperliquid/_autosummary_hyperliquid/eth_defi.hyperliquid.core_writer.html)
- [hyper-evm-lib (GitHub)](https://github.com/hyperliquid-dev/hyper-evm-lib)
- [HyperVault: ERC-4626 vault template for HyperEVM](https://github.com/allora-network/HyperVault)
- [Morpho docs: liquidation tutorial and callback](https://docs.morpho.org/morpho/tutorials/liquidation)
