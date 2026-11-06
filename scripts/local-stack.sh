#!/usr/bin/env bash
# Keeper ↔ contracts, end to end, on a local anvil.
#
# Real Morpho Blue and Uniswap v4 bytecode, the real Deploy / CreateMarkets / SeedPool scripts, and MockHyperCore's
# stubs copied over the HyperCore read precompiles and CoreWriter with anvil_setCode (what the forge tests do with
# vm.etch). HyperCore only acts when someone calls MockHyperCore.processBlock(), which `tick` does every second.
#
#   anvil                                  # terminal 1
#   scripts/local-stack.sh up              # terminal 2: deploy + fund, writes deployments/local.json
#   scripts/local-stack.sh tick            #   ...then leave HyperCore running
#   pnpm --filter @afterbell/keeper risk-engine:stub          # terminal 3
#   scripts/local-stack.sh keeper          # terminal 4
#   scripts/local-stack.sh price 210       # drop NVDA from $217: the market C borrower goes under water
#
# The three-market demo (pnpm replay) starts from `demo` instead of `up`: a thin weekend pool, a borrower in each
# market, the keeper held until the marketC click, and an anvil snapshot that `reset` rewinds to between runs.
#
#   scripts/local-stack.sh demo            # instead of up; then tick, risk engine and keeper as above
#   pnpm replay scene | marketA | marketB | marketC | buyers | monday
#   scripts/local-stack.sh reset           # back to the start of the show
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=${RPC_URL:-http://127.0.0.1:8545}
# anvil's default accounts: 0 deploys and owns everything, 1 is the keeper, 2 drives HyperCore, 3 borrows
# (market C in the demo), 4 and 5 borrow in the demo's markets A and B
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
TICKER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
BORROWER_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
BORROWER_A_PK=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
BORROWER_B_PK=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
# account 6: the redundant backup keeper (keeper2). Accounts 4/5 already borrow in the demo.
KEEPER2_PK=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
CHAIN_JSON=$ROOT/deployments/local-chain.json
DEP_JSON=$ROOT/deployments/local.json
KILL_FILE=$ROOT/deployments/KILL # the keeper's kill switch; the demo holds the keeper with it until marketC
SNAPSHOT_FILE=$ROOT/deployments/local-demo.snapshot

# json <file> <dotted.path>
json() {
  node -e 'const j = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], j))' "$1" "$2"
}

forge_script() {
  (cd "$ROOT/contracts" && forge script "script/$1" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast --slow -q)
}

# borrowers <address:label>…: Morpho can't list a market's borrowers, so the keeper and the API read them here
borrowers() {
  node -e '
    const fs = require("fs");
    const [path, ...pairs] = process.argv.slice(1);
    const dep = JSON.parse(fs.readFileSync(path, "utf8"));
    dep.borrowers = pairs.map((p) => ({ address: p.split(":")[0], label: p.split(":")[1] }));
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$@"
}

# What up and demo share: the chain, HyperCore stubs, Multicall3, the vault and the three markets
base() {
  cast chain-id --rpc-url "$RPC" >/dev/null || { echo "no node at $RPC: start anvil first" >&2; exit 1; }
  cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null

  echo "→ Morpho Blue, v4 PoolManager, USDC, MockHyperCore"
  forge_script LocalChain.s.sol

  echo "→ MockHyperCore over the precompiles (0x…0800–0x…0813) and CoreWriter"
  local stub writer i
  stub=$(cast code "$(json "$CHAIN_JSON" precompileStub)" --rpc-url "$RPC")
  writer=$(cast code "$(json "$CHAIN_JSON" coreWriterStub)" --rpc-url "$RPC")
  for i in $(seq 0 19); do
    cast rpc anvil_setCode "$(printf '0x%040x' $((0x800 + i)))" "$stub" --rpc-url "$RPC" >/dev/null
  done
  cast rpc anvil_setCode 0x3333333333333333333333333333333333333333 "$writer" --rpc-url "$RPC" >/dev/null

  echo "→ Multicall3 at its usual address (the API reads each snapshot in one multicall, as on HyperEVM)"
  cast rpc anvil_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 "$(cat "$ROOT/scripts/multicall3.hex")" \
    --rpc-url "$RPC" >/dev/null

  echo "→ Deploy.s.sol, CreateMarkets.s.sol, SeedPool.s.sol (NETWORK=local)"
  export NETWORK=local \
    USDC_ADDRESS=$(json "$CHAIN_JSON" usdc) \
    CORE_DEPOSIT_WALLET=$(json "$CHAIN_JSON" coreDepositWallet) \
    MORPHO_ADDRESS=$(json "$CHAIN_JSON" morpho) \
    MORPHO_IRM_ADDRESS=$(json "$CHAIN_JSON" irm) \
    POOL_MANAGER_ADDRESS=$(json "$CHAIN_JSON" poolManager) \
    NVDAX_ADDRESS=0x0000000000000000000000000000000000000000 \
    PERP_ASSET=110002 PERP_DEX_INDEX=1 SZ_DECIMALS=3
  forge_script Deploy.s.sol
  forge_script CreateMarkets.s.sol
}

up() {
  base
  THIN=false forge_script SeedPool.s.sol # deep "Monday" pool so unwinds clear the impact limit

  echo "→ margin, LP deposit, market C borrower"
  BORROWER_PK=$BORROWER_PK forge_script LocalActors.s.sol
  borrowers "$(cast wallet address "$BORROWER_PK"):C_afterbell"

  cast rpc evm_setIntervalMining 1 --rpc-url "$RPC" >/dev/null # HyperEVM-like 1 s blocks from here on
  echo "✓ local stack up: $DEP_JSON (vault $(json "$DEP_JSON" vault))"
}

demo() {
  # 1,000 USDC seed: the 1 USDC Core activation fee then costs 0.1% instead of a 10 USDC seed's 10%, so the
  # dashboard's share price starts near 1.00
  export SEED_DEPOSIT=1000000000
  base
  THIN=true forge_script SeedPool.s.sol # the weekend: market A's dump has almost nothing to sell into
  # the vault's hooked pool at Friday's price: weekend buyers take stock from the vault through the hook
  THIN=false USDC_AMOUNT=20000000000 forge_script SeedPool.s.sol

  echo "→ lenders and borrowers in markets A, B, C; NaiveLiquidator funding; LP deposit; Core margin"
  BORROWER_A_PK=$BORROWER_A_PK BORROWER_B_PK=$BORROWER_B_PK BORROWER_C_PK=$BORROWER_PK forge_script LocalDemo.s.sol
  borrowers "$(cast wallet address "$BORROWER_A_PK"):A_naive" "$(cast wallet address "$BORROWER_B_PK"):B_conservative" \
    "$(cast wallet address "$BORROWER_PK"):C_afterbell"

  touch "$KILL_FILE" # the keeper sits out the scene and market A, until the marketC click
  cast rpc evm_setIntervalMining 1 --rpc-url "$RPC" >/dev/null
  cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"' >"$SNAPSHOT_FILE"
  echo "✓ demo ready: $DEP_JSON (vault $(json "$DEP_JSON" vault)); keeper held until marketC"
}

# Rewind anvil to the snapshot demo took, and hold the keeper again. A revert uses the snapshot up, so take a new one.
reset() {
  [[ -f $SNAPSHOT_FILE ]] || { echo "no demo snapshot: run 'scripts/local-stack.sh demo' first" >&2; exit 1; }
  touch "$KILL_FILE"
  [[ $(cast rpc evm_revert "$(cat "$SNAPSHOT_FILE")" --rpc-url "$RPC") == true ]] ||
    { echo "anvil refused the revert: was it restarted? run 'scripts/local-stack.sh demo' again" >&2; exit 1; }
  cast rpc anvil_dropAllTransactions --rpc-url "$RPC" >/dev/null # sends from the abandoned branch
  cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"' >"$SNAPSHOT_FILE"
  echo "✓ back to the start of the demo (block $(cast block-number --rpc-url "$RPC")); keeper held until marketC"
}

tick() {
  local core
  core=$(json "$CHAIN_JSON" core)
  echo "HyperCore: processBlock() every second on $core (ctrl-c to stop)"
  while true; do
    # Fixed gas: each action runs in try/catch, so an estimated limit would starve them into silent drops.
    # Short receipt timeout: after `reset` rewinds the chain, a send from the abandoned branch never gets a receipt,
    # and waiting out the default would hold every HyperCore order for a minute.
    cast send "$core" "processBlock()" --gas-limit 5000000 --timeout 5 --private-key "$TICKER_PK" --rpc-url "$RPC" \
      >/dev/null 2>&1 || true
    sleep 1
  done
}

# price <usd>: move market C's lending oracle and the Core oracle/mark together
price() {
  local usd6
  usd6=$(cast parse-units "$1" 6)
  cast send "$(json "$DEP_JSON" markets.C_afterbell.oracle)" "setPrice(uint256)" "${usd6}000000000000000000" \
    --private-key "$DEPLOYER_PK" --rpc-url "$RPC" >/dev/null
  cast send "$(json "$CHAIN_JSON" core)" "setPx(uint64)" "$((usd6 / 1000))" \
    --private-key "$DEPLOYER_PK" --rpc-url "$RPC" >/dev/null
  echo "NVDA = \$$1 on market C's oracle and on HyperCore"
}

keeper() {
  cd "$ROOT"
  # an unwind is two actions per chunk (sell + sync); the default 6/min would stretch the local run to minutes
  RPC_URL=$RPC KEEPER_PK=$KEEPER_PK DEPLOYMENTS_PATH=$DEP_JSON KILL_SWITCH_FILE=$ROOT/deployments/KILL \
    MAX_ACTIONS_PER_MINUTE=${MAX_ACTIONS_PER_MINUTE:-60} \
    exec pnpm --filter @afterbell/keeper start
}

# keeper2 <risk-engine-url>: the redundant backup keeper (host process, anvil account 6). It shares the
# risk engine with the docker keeper — whichever one the engine elected acts; the other idles in
# "standby". Kill the docker keeper (or this one) and the survivor takes over within LEADER_LEASE_MS.
keeper2() {
  cd "$ROOT"
  RPC_URL=$RPC KEEPER_PK=$KEEPER2_PK KEEPER_ID=${KEEPER2_ID:-keeper-b} DEPLOYMENTS_PATH=$DEP_JSON \
    KILL_SWITCH_FILE=$ROOT/deployments/KILL \
    RISK_ENGINE_URL=${1:-http://127.0.0.1:8081} \
    HEALTH_PORT=${KEEPER2_HEALTH_PORT:-9091} \
    MAX_ACTIONS_PER_MINUTE=${MAX_ACTIONS_PER_MINUTE:-60} \
    exec pnpm --filter @afterbell/keeper start
}

case "${1:-}" in
  up) up ;;
  demo) demo ;;
  reset) reset ;;
  tick) tick ;;
  price) price "${2:?usage: local-stack.sh price <usd>}" ;;
  keeper) keeper ;;
  keeper2) keeper2 "${2:-http://127.0.0.1:8081}" ;;
  *)
    echo "usage: scripts/local-stack.sh up | demo | reset | tick | price <usd> | keeper | keeper2 [risk-engine-url]" >&2
    exit 1
    ;;
esac
