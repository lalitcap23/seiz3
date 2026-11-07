# Uniswap v4 feedback: Seiz3

Seiz3 is a lending-liquidation vault on HyperEVM. Its v4 hook, [`Seiz3Hook`](contracts/src/Seiz3Hook.sol), fills buyers from the vault's hedged stock inside `beforeSwap`, at the HyperCore oracle price plus a spread. The hook also sets the pool's fee by stock-market hours. We built it against v4-core `e50237c4` and v4-periphery `9969eec4`, testing on a local PoolManager and a fork of the HyperEVM mainnet PoolManager (`0x12D4Fd9C…`).

## What worked well

- **Flash accounting made off-curve fills simple.** One `beforeSwap` can `take` USDC to the vault, `sync` and `settle` the vault's NVDAx, and return the delta. The buyer's normal settlement then closes it. That is the feature that keeps this hook from being a thin wrapper.
- **One callback carries everything.** `beforeSwap` returns both the delta and the dynamic-fee override, so the after-hours fee needed no second callback.
- **Swapping already handles hook deltas.** `PoolSwapTest` and our own `unlock` callers needed no changes: the hook's delta arrives inside the swap's `BalanceDelta`.
- **Real bytecode in tests.** Deploying the real PoolManager with `deployCode` made the integration tests trustworthy.

## Where we got stuck

1. **No `BaseHook` in the pinned v4-periphery.** It moved to OpenZeppelin's `uniswap-hooks`. We implemented `IHooks` directly, which meant eight stub callbacks that revert. A one-line pointer in the v4-periphery README would have saved the search.
2. **`HookMiner` is in `test/shared/` and re-hashes the init code on every try.** For a hook of about 10 KB, roughly 16k tries in a `forge script` gets close to the 30M gas a script call has. We wrote a miner that hashes the init code once and works in scratch memory ([`DeployHelpers.mineHookSalt`](contracts/script/DeployHelpers.sol)).
3. **`BeforeSwapDelta` signs are only in a comment.** The `IHooks` NatSpec says "positive: the hook is owed/took currency". Which currency is "specified" depends on `exactInput == zeroForOne` (`Hooks.afterSwap`). We worked out all four cases (exact in or out × currency order) by reading `Hooks.sol`. A table in the docs would make this a five-minute job.
4. **Paying out before the swapper settles uses the PoolManager's own balance.** It isn't documented that a hook's `take` inside `beforeSwap` is funded from the PoolManager's existing token balance, because the swapper hasn't paid yet. We cap each fill at the PoolManager's USDC balance. It matters on a new chain where the PoolManager holds little.
5. **A dynamic-fee pool's fee is 0 until the hook sets it.** That is easy to miss when a hook only overrides on some paths.
6. **No PoolManager on HyperEVM testnet.** Mainnet has one, so on testnet we deployed our own.

## Missing capability or documentation

- A reference custom-accounting hook whose liquidity lives in another contract and is settled in real ERC-20s, not ERC-6909 claims held by the hook. That is the shape of any vault-backed or RFQ-style hook.
- A docs table of `BeforeSwapDelta` signs for the four swap cases.

## The one improvement with the greatest impact

A "custom accounting" docs page with the sign table and the external-inventory example above. Items 3 and 4 cost us the most time, and both would be covered.
