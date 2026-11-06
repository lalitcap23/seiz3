#!/usr/bin/env bash
# Step 3: the vault on HyperEVM testnet against real HyperCore, scaled to a 1 NVDAx liquidation.
#
# What the spikes changed compared with scripts/local-stack.sh:
#  - testnet has no Morpho or Uniswap v4: TestnetInfra.s.sol deploys our own copies;
#  - its CoreDepositWallet never credits HyperCore: the vault gets its margin by a HyperCore-side send, and the keeper
#    must never top up (IDLE_RESERVE_USDC is set out of reach);
#  - xyz is DEX 65 (asset 750002, read index 650002);
#  - HyperCore's oracle can't be moved: market C follows it, and the vault's short fills against a bid we post.
#
# Keys come from .env.local (DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY). In order:
#   scripts/testnet-stack.sh big-blocks on   # the vault and PoolManager only fit in 30M-gas blocks (~1 a minute)
#   scripts/testnet-stack.sh infra           # our Morpho + IRM + PoolManager → deployments/testnet-infra.json
#   scripts/testnet-stack.sh deploy          # MockNVDAx, RiskParams, vault, … → deployments/testnet.json
#   scripts/testnet-stack.sh big-blocks off
#   scripts/testnet-stack.sh markets         # 3 Morpho markets at HyperCore's price, C allow-listed
#   scripts/testnet-stack.sh actors          # risk params, LP deposit, lender, borrower; then the coreFunded flag
#   … by hand: Send 120 USDC (spot) to the vault on HyperCore, and post a bid ≥ 1 NVDA on xyz:NVDA near the oracle
#   scripts/testnet-stack.sh sweep           # the vault's spot USDC → xyz margin
#   scripts/testnet-stack.sh status
#   pnpm --filter @afterbell/keeper risk-engine:stub   # its own terminal
#   scripts/testnet-stack.sh keeper                    # its own terminal
#   scripts/testnet-stack.sh crash           # market C oracle 1.4% under HyperCore's: the keeper liquidates and hedges
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a
. "$ROOT/.env.local"
set +a
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in .env.local}"

RPC=${RPC_URL:-https://rpc.hyperliquid-testnet.xyz/evm}
API=${HL_INFO_API_URL:-https://api.hyperliquid-testnet.xyz/info}
INFRA_JSON=$ROOT/deployments/testnet-infra.json
DEP_JSON=$ROOT/deployments/testnet.json
DEPLOYER=$(cast wallet address "$DEPLOYER_PRIVATE_KEY")
# xyz:NVDA on testnet (info API `perpDexs` / `meta`): mainnet is dex 1, asset 110002
PERP_DEX_INDEX=65
PERP_ASSET=750002
PERP_INDEX=650002
SZ_DECIMALS=3
CORE_MARGIN_USDC=120 # covers the 1 NVDA short: notional × (1 + 20% buffer) / 3x
CRASH_BPS=140        # liquidatable, and inside the vault's 150 bps oracle band
LTV_BPS=7680         # TestnetActors.s.sol

# json <file> <dotted.path>
json() {
  node -e 'const j = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], j))' "$1" "$2"
}

# forge simulates against the latest block, usually a 3M-gas small block: lift that cap for the big deploys
forge_script() {
  (cd "$ROOT/contracts" && forge script "script/$1" --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" \
    --broadcast --slow --timeout 600 --disable-block-gas-limit)
}

send() {
  cast send "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
}

# precompile <address> <arg types> <return types> <args…>: first return value
precompile() {
  local addr=$1 in=$2 out=$3
  shift 3
  cast abi-decode "f()($out)" "$(cast call "$addr" "$(cast abi-encode "f($in)" "$@")" --rpc-url "$RPC")" |
    head -1 | awk '{print $1}'
}

# HyperCore's NVDA oracle in USDC 6 dec (the precompile has 6 - szDecimals decimals)
oracle_usd6() {
  echo $(($(precompile 0x0000000000000000000000000000000000000807 "uint32" "uint64" "$PERP_INDEX") * 10 ** SZ_DECIMALS))
}

core_exists() {
  precompile 0x0000000000000000000000000000000000000810 "address" "bool" "$1"
}

using_big_blocks() {
  cast rpc eth_usingBigBlocks "$DEPLOYER" --rpc-url "$RPC"
}

big_blocks() {
  "${PYTHON:-python3}" "$ROOT/scripts/big-blocks.py" "$1"
  echo "deployer $DEPLOYER using big blocks: $(using_big_blocks)"
}

require_big_blocks() {
  [[ $(using_big_blocks) == true ]] || { echo "run 'big-blocks on' first: this deploy doesn't fit in 3M gas" >&2; exit 1; }
}

infra() {
  require_big_blocks
  forge_script TestnetInfra.s.sol
}

deploy() {
  require_big_blocks
  NETWORK=testnet CORE_ACTIVATION=0 SEED_DEPOSIT=10000000 \
    MORPHO_ADDRESS=$(json "$INFRA_JSON" morpho) POOL_MANAGER_ADDRESS=$(json "$INFRA_JSON" poolManager) \
    PERP_ASSET=$PERP_ASSET PERP_DEX_INDEX=$PERP_DEX_INDEX SZ_DECIMALS=$SZ_DECIMALS \
    forge_script Deploy.s.sol
  echo "vault $(json "$DEP_JSON" vault)"
}

markets() {
  NETWORK=testnet MORPHO_IRM_ADDRESS=$(json "$INFRA_JSON" irm) START_PRICE_USD6=$(oracle_usd6) \
    forge_script CreateMarkets.s.sol
}

actors() {
  local px vault
  px=$(oracle_usd6)
  vault=$(json "$DEP_JSON" vault)
  NETWORK=testnet PRICE_USD6=$px forge_script TestnetActors.s.sol
  # Morpho can't list a market's borrowers, so the keeper reads them here; crash needs the borrow price
  node -e '
    const fs = require("fs");
    const [path, address, px] = process.argv.slice(1);
    const dep = JSON.parse(fs.readFileSync(path, "utf8"));
    dep.borrowers = [{ address, label: "C_afterbell" }];
    dep.demo = { borrowPriceUsd6: px };
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$DEPLOYER" "$px"
  # coreFunded makes the vault count its Core USDC. Only a CoreDepositWallet deposit sets it, and on testnet that
  # deposit is never credited, so this costs 1 USDC.
  send "$vault" "activateCore(uint256)" 1000000
  echo "borrower $DEPLOYER at \$$(cast format-units "$px" 6), coreFunded $(cast call "$vault" "coreFunded()(bool)" --rpc-url "$RPC")"
  echo "next, by hand: Send $CORE_MARGIN_USDC USDC (spot) to $vault on app.hyperliquid-testnet.xyz, then: sweep"
}

sweep() {
  local vault
  vault=$(json "$DEP_JSON" vault)
  until [[ $(core_exists "$vault") == true ]]; do
    echo "waiting for the vault's HyperCore account (Send USDC to $vault on HyperCore)…"
    sleep 5
  done
  send "$vault" "sweepSpotToDex()"
  echo "swept spot → xyz; margin shows up in a few blocks (status)"
}

crash() {
  local live target threshold oracle
  live=$(oracle_usd6)
  target=$((live * (10000 - CRASH_BPS) / 10000))
  threshold=$(($(json "$DEP_JSON" demo.borrowPriceUsd6) * LTV_BPS / 7700))
  if ((target >= threshold)); then
    echo "NVDA rose on HyperCore since the borrow: \$$(cast format-units "$target" 6) wouldn't make the borrower" \
      "liquidatable (needs < \$$(cast format-units "$threshold" 6)) and anything lower is outside the oracle band" >&2
    exit 1
  fi
  oracle=$(json "$DEP_JSON" markets.C_afterbell.oracle)
  send "$oracle" "setPrice(uint256)" "${target}000000000000000000"
  echo "market C oracle \$$(cast format-units "$target" 6), HyperCore \$$(cast format-units "$live" 6): the keeper should liquidate"
}

status() {
  local vault usdc
  vault=$(json "$DEP_JSON" vault)
  usdc=$(json "$DEP_JSON" usdc)
  echo "vault        $vault"
  echo "HyperCore    exists=$(core_exists "$vault")  xyz value=$(cast format-units \
    "$(precompile 0x000000000000000000000000000000000000080F "uint32,address" "int64,uint64,uint64,int64" \
      "$PERP_DEX_INDEX" "$vault")" 6)  szi=$(precompile 0x0000000000000000000000000000000000000813 \
    "address,uint32" "int64,uint64,int64,uint32,bool" "$vault" "$PERP_INDEX")"
  echo "vault        idle=$(cast format-units "$(cast call "$usdc" "balanceOf(address)(uint256)" "$vault" \
    --rpc-url "$RPC" | awk '{print $1}')" 6) USDC  inventory=$(cast format-units "$(cast call "$vault" \
    "inventory()(uint256)" --rpc-url "$RPC" | awk '{print $1}')" 18)  confirmedShort=$(cast call "$vault" \
    "confirmedShort()(int64)" --rpc-url "$RPC")  paused=$(cast call "$vault" "paused()(bool)" --rpc-url "$RPC")"
  echo "prices       HyperCore=\$$(cast format-units "$(oracle_usd6)" 6)  market C=\$$(cast format-units \
    "$(cast call "$(json "$DEP_JSON" markets.C_afterbell.oracle)" "price()(uint256)" --rpc-url "$RPC" |
      awk '{print $1}')" 24)"
  curl -s -m 15 "$API" -H 'Content-Type: application/json' -d '{"type":"l2Book","coin":"xyz:NVDA"}' | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [bids, asks] = JSON.parse(s).levels;
      const top = (l) => (l ? `${l.sz} @ ${l.px}` : "none");
      console.log(`xyz:NVDA     best bid ${top(bids[0])}, best ask ${top(asks[0])}`);
    });
  '
}

keeper() {
  : "${KEEPER_PRIVATE_KEY:?set KEEPER_PRIVATE_KEY in .env.local}"
  cd "$ROOT"
  # IDLE_RESERVE_USDC out of reach: a top-up goes through testnet's CoreDepositWallet, which loses it.
  # MORPHO_API_ENABLED=0: Morpho's API doesn't index our own Morpho copy. TICK_MS=2000 eases the public RPC's limits.
  RPC_URL=$RPC KEEPER_PK=$KEEPER_PRIVATE_KEY DEPLOYMENTS_PATH=$DEP_JSON KILL_SWITCH_FILE=$ROOT/deployments/KILL \
    MORPHO_API_ENABLED=0 IDLE_RESERVE_USDC=1000000000 TICK_MS=${TICK_MS:-2000} \
    exec pnpm --filter @afterbell/keeper start
}

case "${1:-}" in
  big-blocks) big_blocks "${2:?usage: testnet-stack.sh big-blocks on|off}" ;;
  infra) infra ;;
  deploy) deploy ;;
  markets) markets ;;
  actors) actors ;;
  sweep) sweep ;;
  crash) crash ;;
  status) status ;;
  keeper) keeper ;;
  *)
    echo "usage: scripts/testnet-stack.sh big-blocks on|off | infra | deploy | markets | actors | sweep | status |" \
      "keeper | crash" >&2
    exit 1
    ;;
esac
