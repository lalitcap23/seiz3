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
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=${RPC_URL:-http://127.0.0.1:8545}
# anvil's default accounts: 0 deploys and owns everything, 1 is the keeper, 2 drives HyperCore, 3 borrows
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
TICKER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
BORROWER_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
CHAIN_JSON=$ROOT/deployments/local-chain.json
DEP_JSON=$ROOT/deployments/local.json

# json <file> <dotted.path>
json() {
  node -e 'const j = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], j))' "$1" "$2"
}

forge_script() {
  (cd "$ROOT/contracts" && forge script "script/$1" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast --slow -q)
}

up() {
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
  THIN=false forge_script SeedPool.s.sol # deep "Monday" pool so unwinds clear the impact limit

  echo "→ margin, LP deposit, market C borrower"
  BORROWER_PK=$BORROWER_PK forge_script LocalActors.s.sol
  # Morpho can't list a market's borrowers, so the keeper reads them from the deployment file
  node -e '
    const fs = require("fs");
    const [path, address] = process.argv.slice(1);
    const dep = JSON.parse(fs.readFileSync(path, "utf8"));
    dep.borrowers = [{ address, label: "C_afterbell" }];
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$(cast wallet address "$BORROWER_PK")"

  cast rpc evm_setIntervalMining 1 --rpc-url "$RPC" >/dev/null # HyperEVM-like 1 s blocks from here on
  echo "✓ local stack up: $DEP_JSON (vault $(json "$DEP_JSON" vault))"
}

tick() {
  local core
  core=$(json "$CHAIN_JSON" core)
  echo "HyperCore: processBlock() every second on $core (ctrl-c to stop)"
  while true; do
    # Fixed gas: each action runs in try/catch, so an estimated limit would starve them into silent drops.
    cast send "$core" "processBlock()" --gas-limit 5000000 --private-key "$TICKER_PK" --rpc-url "$RPC" \
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

case "${1:-}" in
  up) up ;;
  tick) tick ;;
  price) price "${2:?usage: local-stack.sh price <usd>}" ;;
  keeper) keeper ;;
  *)
    echo "usage: scripts/local-stack.sh up | tick | price <usd> | keeper" >&2
    exit 1
    ;;
esac
