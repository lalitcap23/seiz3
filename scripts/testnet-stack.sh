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
#
# Public testers (after step 3, same vault):
#   scripts/testnet-stack.sh extras                 # Faucet, swap router, NaiveLiquidator on its own thin pool
#   scripts/testnet-stack.sh seed deep <usdc>       # the vault's 0.3% pool, centred on HyperCore's oracle
#   scripts/testnet-stack.sh seed thin <usdc>       # market A's 0.05% weekend pool
#   scripts/testnet-stack.sh fund-vault <usdc>      # LP deposit: idle USDC pays each liquidation's repayment
#   scripts/testnet-stack.sh fund-faucet <nvdax> <usdc> <hype>
#   scripts/testnet-stack.sh fund-naive <usdc>      # covers market A's shortfall when it dumps into the thin pool
#   scripts/testnet-stack.sh bots                   # oracle follower + pool rebalancer (+ HyperCore market maker
#                                                   #   with HL_MM_PRIVATE_KEY in .env.local), its own terminal
#   scripts/testnet-stack.sh release                # after a crash: the oracles follow HyperCore again
#
# Before a fresh deploy (pnpm testnet:down first, or the bots put money back):
#   scripts/testnet-stack.sh reclaim                # every USDC we put in → the deployer; rerun once the vault's
#                                                   #   HyperCore margin has landed back on HyperEVM
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
HOLD_FILE=$ROOT/deployments/BOTS_HOLD # while it exists the oracle and pool bots stand still
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

extras() {
  # FAUCET_OPERATOR: the API's faucet key (FAUCET_OPERATOR_PRIVATE_KEY), which drips for testers who have no gas yet
  local op=""
  [[ -n ${FAUCET_OPERATOR_PRIVATE_KEY:-} ]] && op=$(cast wallet address "$FAUCET_OPERATOR_PRIVATE_KEY")
  NETWORK=testnet FAUCET_OPERATOR=${op:-0x0000000000000000000000000000000000000000} forge_script TestnetExtras.s.sol
}

# seed deep|thin <usdc>: adds liquidity around HyperCore's oracle (the pool is initialised there on first use)
seed() {
  local kind=${1:?usage: seed deep|thin <usdc>} usdc=${2:?usage: seed deep|thin <usdc>} thin
  case $kind in deep) thin=false ;; thin) thin=true ;; *) echo "seed deep|thin <usdc>" >&2; exit 1 ;; esac
  # RANGE_BPS from the caller's env passes through (SeedPool's default: ±3% thin, ±10% deep)
  NETWORK=testnet THIN=$thin USDC_AMOUNT=$((usdc * 1000000)) PRICE_USD6=$(oracle_usd6) forge_script SeedPool.s.sol
}

fund_vault() {
  local amount=$((${1:?usage: fund-vault <usdc>} * 1000000)) vault usdc
  vault=$(json "$DEP_JSON" vault)
  usdc=$(json "$DEP_JSON" usdc)
  send "$usdc" "approve(address,uint256)" "$vault" "$amount"
  send "$vault" "deposit(uint256,address)" "$amount" "$DEPLOYER"
  echo "vault idle now $(cast format-units "$(cast call "$usdc" "balanceOf(address)(uint256)" "$vault" --rpc-url "$RPC" |
    awk '{print $1}')" 6) USDC"
}

fund_faucet() {
  local nvdax=${1:?usage: fund-faucet <nvdax> <usdc> <hype>} usdc=${2:?} hype=${3:?} faucet
  faucet=$(json "$DEP_JSON" faucet)
  [[ $nvdax != 0 ]] && send "$(json "$DEP_JSON" nvdax)" "mint(address,uint256)" "$faucet" "$(cast to-wei "$nvdax")"
  [[ $usdc != 0 ]] && send "$(json "$DEP_JSON" usdc)" "transfer(address,uint256)" "$faucet" "$((usdc * 1000000))"
  [[ $hype != 0 ]] && cast send "$faucet" --value "$(cast to-wei "$hype")" --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC" >/dev/null
  echo "faucet $faucet funded: +$nvdax NVDAx, +$usdc USDC, +$hype HYPE"
}

fund_naive() {
  local naive
  naive=$(json "$DEP_JSON" naiveLiquidator)
  send "$(json "$DEP_JSON" usdc)" "transfer(address,uint256)" "$naive" "$((${1:?usage: fund-naive <usdc>} * 1000000))"
  echo "NaiveLiquidator $naive funded"
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
  echo crash >"$HOLD_FILE" # or the oracle follower puts it straight back
  send "$oracle" "setPrice(uint256)" "${target}000000000000000000"
  echo "market C oracle \$$(cast format-units "$target" 6), HyperCore \$$(cast format-units "$live" 6): the keeper should liquidate"
  echo "the bots hold until: scripts/testnet-stack.sh release"
}

release() {
  rm -f "$HOLD_FILE"
  echo "bots released: the oracles follow HyperCore again"
}

bots() {
  cd "$ROOT"
  local which=${BOTS:-oracle,pool,alerts}
  [[ -n ${HL_MM_PRIVATE_KEY:-} && -z ${BOTS:-} ]] && which=oracle,pool,mm,alerts
  RPC_URL=$RPC NETWORK=testnet DEPLOYMENTS_PATH=$DEP_JSON HOLD_FILE=$HOLD_FILE BOTS=$which \
    exec pnpm --filter @afterbell/bots start
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

# first word of a cast call: drops the "[1.2e8]" suffix
call() {
  cast call "$@" --rpc-url "$RPC" | head -1 | awk '{print $1}'
}

# liquidity <poolManager> <owner> <poolKey tuple> <lower> <upper> <salt>: a v4 position's liquidity (StateLibrary's slots)
liquidity() {
  local pm=$1 owner=$2 key=$3 lower=$4 upper=$5 salt=$6 id state pk raw
  id=$(cast keccak "$(cast abi-encode "f((address,address,uint24,int24,address))" "$key")")
  state=$(cast keccak "$(cast concat-hex "$id" "$(cast to-uint256 6)")")
  pk=$(cast keccak "$(cast abi-encode --packed "f(address,int24,int24,bytes32)" "$owner" "$lower" "$upper" "$salt")")
  raw=$(cast call "$pm" "extsload(bytes32)(bytes32)" "$(cast keccak "$(cast concat-hex "$pk" \
    "$(node -e 'console.log("0x" + (BigInt(process.argv[1]) + 6n).toString(16).padStart(64, "0"))' "$state")")")" \
    --rpc-url "$RPC")
  node -e 'console.log((BigInt(process.argv[1]) & ((1n << 128n) - 1n)).toString())' "$raw"
}

reclaim() {
  local usdc vault morpho pm bal hype
  if docker compose -f "$ROOT/docker-compose.testnet.yml" ps -q 2>/dev/null | grep -q .; then
    echo "the testnet stack is running: pnpm testnet:down first" >&2
    exit 1
  fi
  usdc=$(json "$DEP_JSON" usdc)
  vault=$(json "$DEP_JSON" vault)
  morpho=$(json "$DEP_JSON" morpho)
  pm=$(json "$DEP_JSON" poolManager)
  usd() { cast format-units "$1" 6; }

  local holder
  for holder in faucet naiveLiquidator; do
    local addr
    addr=$(json "$DEP_JSON" "$holder")
    bal=$(call "$usdc" "balanceOf(address)(uint256)" "$addr")
    if [[ $bal != 0 ]]; then
      send "$addr" "withdraw(address,address,uint256)" "$usdc" "$DEPLOYER" "$bal"
      echo "$holder: $(usd "$bal") USDC"
    fi
  done
  hype=$(cast balance "$(json "$DEP_JSON" faucet)" --rpc-url "$RPC")
  if [[ $hype != 0 ]]; then
    send "$(json "$DEP_JSON" faucet)" "withdraw(address,address,uint256)" 0x0000000000000000000000000000000000000000 \
      "$DEPLOYER" "$hype"
    echo "faucet: $(cast from-wei "$hype") HYPE"
  fi

  # every position SeedPool ever added, through whichever PoolSeeder it used; pulled whole, paid to the deployer
  local pos seeder key lower upper salt liq
  while read -r seeder key lower upper salt; do
    [[ -z $seeder ]] && continue
    liq=$(liquidity "$pm" "$seeder" "$key" "$lower" "$upper" "$salt")
    [[ $liq == 0 ]] && continue
    before=$(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER")
    send "$seeder" "modifyLiquidity((address,address,uint24,int24,address),int24,int24,int256,bytes32)" \
      "$key" "$lower" "$upper" "-$liq" "$salt"
    echo "pool position $lower..$upper (salt ${salt: -1}): $(usd $(($(call "$usdc" "balanceOf(address)(uint256)" \
      "$DEPLOYER") - before))) USDC"
  done < <(node -e '
    const fs = require("fs"), dir = process.argv[1], seen = new Set();
    if (!fs.existsSync(dir)) process.exit(0);
    for (const f of fs.readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)))
      for (const t of JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).transactions)
        if (t.function?.startsWith("modifyLiquidity(") && !t.arguments[3].startsWith("-")) {
          const [key, lower, upper, , salt] = t.arguments;
          const row = [t.contractAddress, key.replace(/\s/g, ""), lower, upper, salt].join(" ");
          if (!seen.has(row)) seen.add(row), console.log(row);
        }
  ' "$ROOT/contracts/broadcast/SeedPool.s.sol/998")

  # Morpho: repay the deployer's own loans, then take back whatever supply isn't lent out
  local name id params shares borrowShares supply borrow free
  for name in A_naive B_conservative C_afterbell; do
    id=$(json "$DEP_JSON" "markets.$name.id")
    params="($(cast call "$morpho" "idToMarketParams(bytes32)(address,address,address,address,uint256)" "$id" \
      --rpc-url "$RPC" | awk '{print $1}' | paste -sd, -))"
    read -r shares borrowShares _ < <(cast call "$morpho" "position(bytes32,address)(uint256,uint128,uint128)" \
      "$id" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}' | paste -sd' ' -)
    if [[ $borrowShares != 0 ]]; then
      send "$usdc" "approve(address,uint256)" "$morpho" 1000000000
      send "$morpho" "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)" \
        "$params" 0 "$borrowShares" "$DEPLOYER" 0x
      send "$usdc" "approve(address,uint256)" "$morpho" 0
      echo "market $name: deployer's loan repaid"
    fi
    [[ $shares == 0 ]] && continue
    read -r supply _ borrow _ < <(cast call "$morpho" \
      "market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)" "$id" --rpc-url "$RPC" |
      awk '{print $1}' | paste -sd' ' -)
    if [[ $borrow == 0 ]]; then
      before=$(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER")
      send "$morpho" "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)" \
        "$params" 0 "$shares" "$DEPLOYER" "$DEPLOYER"
      echo "market $name: $(usd $(($(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER") - before))) USDC supply"
    else
      free=$((supply - borrow))
      ((free > 0)) && send "$morpho" "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)" \
        "$params" "$free" 0 "$DEPLOYER" "$DEPLOYER"
      echo "market $name: $(usd "$free") USDC back, $(usd "$borrow") still lent out to testers (rerun once repaid)"
    fi
  done

  # the vault's HyperCore margin → its HyperEVM idle (only when flat; it lands a few blocks later), then redeem
  local value
  value=$(precompile 0x000000000000000000000000000000000000080F "uint32,address" "int64,uint64,uint64,int64" \
    "$PERP_DEX_INDEX" "$vault")
  if ((value > 0)); then
    if send "$vault" "withdrawMargin(uint256)" "$value" 2>/dev/null; then
      echo "vault: $(usd "$value") USDC margin sent HyperCore → HyperEVM; rerun reclaim in a minute to redeem it"
    else
      echo "vault: $(usd "$value") USDC margin stays on HyperCore (not flat: stock or short still open)"
    fi
  fi
  shares=$(call "$vault" "maxRedeem(address)(uint256)" "$DEPLOYER")
  if [[ $shares != 0 ]]; then
    before=$(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER")
    send "$vault" "requestWithdraw(uint256)" "$shares"
    echo "vault: $(usd $(($(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER") - before))) USDC redeemed"
  fi

  echo "deployer now $(usd "$(call "$usdc" "balanceOf(address)(uint256)" "$DEPLOYER")") USDC," \
    "$(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") HYPE"
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
  extras) extras ;;
  seed) seed "${2:-}" "${3:-}" ;;
  fund-vault) fund_vault "${2:-}" ;;
  fund-faucet) fund_faucet "${2:-}" "${3:-}" "${4:-}" ;;
  fund-naive) fund_naive "${2:-}" ;;
  bots) bots ;;
  release) release ;;
  reclaim) reclaim ;;
  *)
    echo "usage: scripts/testnet-stack.sh big-blocks on|off | infra | deploy | markets | actors | sweep | status |" \
      "keeper | crash | extras | seed deep|thin <usdc> | fund-vault <usdc> |" \
      "fund-faucet <nvdax> <usdc> <hype> | fund-naive <usdc> | bots | release | reclaim" >&2
    exit 1
    ;;
esac
