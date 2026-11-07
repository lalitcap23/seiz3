#!/usr/bin/env bash
# Seiz3 on Base Sepolia: the vault, Morpho and Uniswap v4 on Base; the short on HyperCore, placed by the relayer.
#
#   Morpho Blue + Uniswap v4 PoolManager: Morpho's and Uniswap's own Base Sepolia deployments (no copies of either)
#   Seiz3VaultRemote + Seiz3HookRemote + HyperCoreGateway: ours (contracts/src/remote)
#   relayer (packages/relayer): gateway orders → the hedge account on HyperCore → snapshots back to the gateway
#   keeper (packages/keeper): unchanged; it drives Seiz3VaultRemote through the same ABI
#
# The HyperEVM stacks (scripts/local-stack.sh, scripts/testnet-stack.sh) are untouched; this one writes its own files:
# deployments/local-base*.json and deployments/base-sepolia*.json.
#
# ─── local: a plain anvil on :8546 with Morpho/v4 bytecode set up like Base Sepolia, HyperCore = MockHyperCore ───
#   anvil --port 8546                          # terminal 1
#   scripts/base-stack.sh local up             # deploy + markets + pools + LP/lender/borrower (~40 s)
#   scripts/base-stack.sh local relayer        # terminal 2: BACKEND=mock
#   scripts/base-stack.sh local activate       # once the relayer's first snapshot landed
#   pnpm --filter @seiz3/keeper risk-engine:stub   # terminal 3
#   scripts/base-stack.sh local keeper         # terminal 4
#   scripts/base-stack.sh local price 210      # market C under water: liquidate → relayer shorts → sync
#   scripts/base-stack.sh local hook-fill 50   # a buyer filled from the vault by the hook; buy-back relayed
#   scripts/base-stack.sh local monday 210     # market open, pool on the oracle: the keeper unwinds to flat
#   scripts/base-stack.sh local status
#   scripts/base-stack.sh local round          # all of the above, checked, against the running relayer + keeper
#
# ─── sepolia: Base Sepolia + real HyperCore testnet (xyz:NVDA, dex 65) ───
# Keys from .env.local: DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY (Base Sepolia ETH for both), BASE_HEDGE_PRIVATE_KEY
# (the hedge account on HyperCore: USDC on xyz, plus Base Sepolia ETH if it is also the relayer), and optionally
# BASE_RELAYER_PRIVATE_KEY (the gateway's relayer; default BASE_HEDGE_PRIVATE_KEY).
#   scripts/base-stack.sh sepolia infra        # test USDC (Morpho + PoolManager are Base Sepolia's own)
#   scripts/base-stack.sh sepolia deploy
#   scripts/base-stack.sh sepolia markets      # priced at HyperCore's live NVDA oracle
#   scripts/base-stack.sh sepolia seed deep 2000 ; scripts/base-stack.sh sepolia seed thin 200
#   scripts/base-stack.sh sepolia actors       # risk params, LP deposit, lender, borrower at 76.8% LTV
#   scripts/base-stack.sh sepolia hedge-status # fund the hedge account on HyperCore (Send USDC in the app), then:
#   scripts/base-stack.sh sepolia to-xyz 120   # its spot USDC → the xyz DEX (the short's margin)
#   scripts/base-stack.sh sepolia relayer      # own terminal: BACKEND=hyperliquid
#   scripts/base-stack.sh sepolia activate
#   scripts/base-stack.sh sepolia keeper       # own terminal (+ risk-engine:stub)
#   scripts/base-stack.sh sepolia bots         # own terminal: oracle follower, pool rebalancer, HyperCore market maker
#   scripts/base-stack.sh sepolia crash        # market C 1.4% under HyperCore's oracle → liquidate → relayer shorts
#   scripts/base-stack.sh sepolia release | borrow <nvdax> | hook-fill <usdc> | status
#   scripts/base-stack.sh sepolia cre [--broadcast] | cre-loop   # Chainlink CRE → RiskParams + the gateway
#   scripts/base-stack.sh sepolia live         # all of the services above in one terminal, or in docker instead:
#   pnpm base:up                               # docker-compose.base.yml: each container runs this script's command
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NET=${1:-}
CMD=${2:-}
shift 2 2>/dev/null || true

# xyz:NVDA on HyperCore testnet (info API `perpDexs` / `meta`): the local MockHyperCore uses the same ids
PERP_DEX_INDEX=65
PERP_ASSET=750002
PERP_INDEX=650002
SZ_DECIMALS=3
CRASH_BPS=140 # liquidatable, and inside the vault's 150 bps oracle band
LTV_BPS=7680  # RemoteActors.s.sol
ZERO=0x0000000000000000000000000000000000000000

case $NET in
  local | fork)
    # local: a plain anvil on :8546. fork: anvil on :8547 forking Base Sepolia (anvil --fork-url https://sepolia.base.org
    # --port 8547): Morpho's and Uniswap's real deployments and Chainlink's real CRE simulation forwarder, from chain state.
    # Both trade MockHyperCore through the relayer's mock backend.
    if [[ $NET == local ]]; then
      RPC=${RPC_URL:-http://127.0.0.1:8546}
      NETWORK=local-base
    else
      RPC=${RPC_URL:-http://127.0.0.1:8547}
      NETWORK=base-fork
    fi
    # anvil's default accounts: 0 deploys and owns, 1 keeper, 2 relayer, 3 borrows; 7 is the hedge account's address
    DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
    RELAYER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
    BORROWER_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
    HEDGE=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
    ;;
  sepolia)
    # in docker (docker-compose.base.yml) .env.local arrives as the container's environment instead
    if [[ -f $ROOT/.env.local ]]; then
      set -a
      # shellcheck disable=SC1091
      . "$ROOT/.env.local"
      set +a
    fi
    # Infura when there's a key (the keeper, relayer and bots poll every second; the public RPC rate-limits)
    RPC=${BASE_SEPOLIA_RPC_URL:-${INFURA_API_KEY:+https://base-sepolia.infura.io/v3/$INFURA_API_KEY}}
    RPC=${RPC:-https://sepolia.base.org}
    NETWORK=base-sepolia
    DEPLOYER_PK=${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in .env.local}
    KEEPER_PK=${KEEPER_PRIVATE_KEY:-}
    HEDGE_PK=${BASE_HEDGE_PRIVATE_KEY:-}
    RELAYER_PK=${BASE_RELAYER_PRIVATE_KEY:-$HEDGE_PK}
    # empty without foundry (the docker images): the relayer then reads the gateway's hedgeAccount
    HEDGE=${BASE_HEDGE_ACCOUNT:-$([[ -n $HEDGE_PK ]] && cast wallet address "$HEDGE_PK" 2>/dev/null || echo "")}
    BORROWER_PK=""
    ;;
  *)
    echo "usage: scripts/base-stack.sh local|fork|sepolia <command> [args] (see the header)" >&2
    exit 1
    ;;
esac

# an anvil (plain or forking Base Sepolia) with MockHyperCore behind the relayer
sim() { [[ $NET == local || $NET == fork ]]; }

# single <name>: one <name> per deployment on this machine. Two relayers place every HyperCore order twice (both see it
# unacknowledged), two market makers cancel each other's quotes, two keepers fight over one health port. The lock is
# this process's pid (services `exec`, so it stays theirs); a dead pid's lock is taken over.
single() {
  # in docker, compose runs one container per service, and a pid from its namespace means nothing on the host
  [[ -f /.dockerenv ]] && return 0
  # nor beside the docker stack's own (docker-compose.base.yml): two relayers there and here placed orders twice
  if [[ $NETWORK == base-sepolia ]] && [[ -n $(docker ps -q --filter label=com.docker.compose.project=seiz3-base \
    $([[ $1 != live ]] && echo "--filter label=com.docker.compose.service=$1") 2>/dev/null) ]]; then
    echo "the docker stack (pnpm base:up) already runs $1 for $NETWORK: use it, or pnpm base:down first" >&2
    exit 1
  fi
  local f=$ROOT/deployments/.$NETWORK-$1.pid pid
  if [[ -f $f ]] && pid=$(cat "$f") && [[ $pid != "$$" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "a $1 for $NETWORK is already running (pid $pid): stop it first (or use that one)" >&2
    exit 1
  fi
  echo $$ >"$f"
}

INFRA_JSON=$ROOT/deployments/$NETWORK-infra.json
DEP_JSON=$ROOT/deployments/$NETWORK.json
HOLD_FILE=$ROOT/deployments/BASE_BOTS_HOLD
# the docker images carry no foundry: their services (keeper, relayer, bots, api, cre-loop) don't need the address
DEPLOYER=$(cast wallet address "$DEPLOYER_PK" 2>/dev/null || true)

json() {
  node -e 'const j = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], j))' "$1" "$2"
}

forge_script() {
  (cd "$ROOT/contracts" && forge script "script/$1" --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast --slow -q)
}

send() {
  cast send "$@" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" >/dev/null
}

# first word of a cast call: drops the "[1.2e8]" suffix
call() {
  cast call "$@" --rpc-url "$RPC" | head -1 | awk '{print $1}'
}

usd() { cast format-units "$1" 6; }

# HyperCore's NVDA oracle in USDC 6 dec, as the vault sees it: the gateway's last snapshot, else Hyperliquid's API
oracle_usd6() {
  local raw=""
  if [[ -f $DEP_JSON ]]; then raw=$(call "$(json "$DEP_JSON" hyperCoreGateway)" "oraclePx(uint32)(uint64)" "$PERP_INDEX" 2>/dev/null || true); fi
  if [[ -z $raw || $raw == 0 ]]; then
    if sim; then
      raw=$(call "$(json "$INFRA_JSON" core)" "oraclePx()(uint64)")
    else
      raw=$(curl -s -m 15 https://api.hyperliquid-testnet.xyz/info -H 'Content-Type: application/json' \
        -d '{"type":"metaAndAssetCtxs","dex":"xyz"}' | node -e '
          let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const [m, c] = JSON.parse(s); const i = m.universe.findIndex((u) => u.name === "xyz:NVDA");
            console.log(String(Math.round(Number(c[i].oraclePx) * 10 ** (6 - Number(process.argv[1])))));
          });' "$SZ_DECIMALS")
    fi
  fi
  echo $((raw * 10 ** SZ_DECIMALS))
}

# borrowers <address:label>…: Morpho can't list a market's borrowers, so the keeper and the API read them here
borrowers() {
  node -e '
    const fs = require("fs");
    const [path, px, ...pairs] = process.argv.slice(1);
    const dep = JSON.parse(fs.readFileSync(path, "utf8"));
    dep.borrowers = pairs.map((p) => ({ address: p.split(":")[0], label: p.split(":")[1] }));
    dep.demo = { ...(dep.demo ?? {}), borrowPriceUsd6: px };
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$@"
}

# ─── deploy ──────────────────────────────────────────────────────────────────

infra() {
  cast chain-id --rpc-url "$RPC" >/dev/null || { echo "no node at $RPC" >&2; exit 1; }
  MOCK_CORE=$(sim && echo true || echo false) \
    NETWORK=$NETWORK HEDGE_ACCOUNT=${HEDGE:-$ZERO} PERP_INDEX=$PERP_INDEX PERP_DEX_INDEX=$PERP_DEX_INDEX \
    SZ_DECIMALS=$SZ_DECIMALS START_PRICE_USD6=${START_PRICE_USD6:-$(oracle_usd6)} forge_script RemoteInfra.s.sol
  echo "infra: $INFRA_JSON (Morpho $(json "$INFRA_JSON" morpho), PoolManager $(json "$INFRA_JSON" poolManager))"
}

deploy() {
  local relayer
  relayer=$(cast wallet address "${RELAYER_PK:?set BASE_RELAYER_PRIVATE_KEY or BASE_HEDGE_PRIVATE_KEY}")
  NETWORK=$NETWORK USDC_ADDRESS=$(json "$INFRA_JSON" usdc) MORPHO_ADDRESS=$(json "$INFRA_JSON" morpho) \
    POOL_MANAGER_ADDRESS=$(json "$INFRA_JSON" poolManager) SWAP_ROUTER=$(json "$INFRA_JSON" swapRouter) \
    NVDAX_ADDRESS=$ZERO PERP_ASSET=$PERP_ASSET PERP_DEX_INDEX=$PERP_DEX_INDEX SZ_DECIMALS=$SZ_DECIMALS \
    SEED_DEPOSIT=${SEED_DEPOSIT:-10000000} RELAYER_ADDRESS=$relayer HEDGE_ACCOUNT=${HEDGE:?no hedge account} \
    forge_script DeployRemote.s.sol
  echo "vault $(json "$DEP_JSON" vault), gateway $(json "$DEP_JSON" hyperCoreGateway), hedge account $HEDGE, relayer $relayer"
}

# Morpho's AdaptiveCurveIrm on Base Sepolia (enabled on its Morpho, as on Base mainnet): market C accrues interest, so a
# borrow right at the LLTV tips over within about a minute, as the /try page's "Max" expects. The plain local anvil's
# Morpho has no IRM enabled but address(0).
ADAPTIVE_CURVE_IRM=0x46415998764C29aB2a25CbeA6254146D50D22687

# markets: three demo markets (A, B, C) on new DemoOracles, C allow-listed on the vault; rerunning replaces them in the
# deployment file (the old ones stay on Morpho, unused)
markets() {
  local irm=$ZERO
  [[ $NET != local ]] && irm=$ADAPTIVE_CURVE_IRM
  NETWORK=$NETWORK MORPHO_IRM_ADDRESS=${MORPHO_IRM:-$irm} START_PRICE_USD6=${START_PRICE_USD6:-$(oracle_usd6)} \
    forge_script CreateMarkets.s.sol
}

# seed deep|thin <usdc>: liquidity around HyperCore's oracle (the pool is initialised there on first use)
seed() {
  local kind=${1:?usage: seed deep|thin <usdc>} amount=${2:?usage: seed deep|thin <usdc>} thin
  case $kind in deep) thin=false ;; thin) thin=true ;; *) echo "seed deep|thin <usdc>" >&2; exit 1 ;; esac
  NETWORK=$NETWORK THIN=$thin USDC_AMOUNT=$((amount * 1000000)) PRICE_USD6=$(oracle_usd6) forge_script SeedPool.s.sol
}

# extras: what /try needs on top: a funded Faucet (relayed by the API's FAUCET_OPERATOR_PRIVATE_KEY, which gets a
# little gas here), lender liquidity in the three markets, LP cash in the vault. Needs the relayer running once the
# vault is activated: a deposit prices shares from the gateway, which is stale without it.
extras() {
  local op=$ZERO
  if [[ -n ${FAUCET_OPERATOR_PRIVATE_KEY:-} ]] && ! sim; then
    op=$(cast wallet address "$FAUCET_OPERATOR_PRIVATE_KEY")
    [[ $(cast balance "$op" --rpc-url "$RPC") == 0 ]] && cast send "$op" --value 0.002ether \
      --private-key "$DEPLOYER_PK" --rpc-url "$RPC" >/dev/null && echo "faucet operator $op: 0.002 ETH for relay gas"
  fi
  NETWORK=$NETWORK FAUCET_OPERATOR=$op forge_script RemoteExtras.s.sol
  echo "faucet $(json "$DEP_JSON" faucet), vault idle $(usd "$(call "$(json "$DEP_JSON" usdc)" "balanceOf(address)(uint256)" "$(json "$DEP_JSON" vault)")") USDC"
}

actors() {
  local px borrower
  px=${PRICE_USD6:-$(oracle_usd6)}
  NETWORK=$NETWORK PRICE_USD6=$px BORROWER_PK=${BORROWER_PK:-0} forge_script RemoteActors.s.sol
  borrower=$([[ -n $BORROWER_PK ]] && cast wallet address "$BORROWER_PK" || echo "$DEPLOYER")
  borrowers "$px" "$borrower:C_seiz3"
  echo "market C borrower $borrower at \$$(usd "$px") (${LTV_BPS} bps); next: relayer, then activate"
}

up() {
  sim || { echo "up is for local / fork: on sepolia run infra, deploy, markets, seed, actors" >&2; exit 1; }
  cast chain-id --rpc-url "$RPC" >/dev/null || { echo "no anvil at $RPC (see the header)" >&2; exit 1; }
  cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null
  if [[ $(cast codesize 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url "$RPC") == 0 ]]; then
    echo "→ Multicall3 at its usual address, as on Base Sepolia (the API reads each snapshot in one multicall)"
    cast rpc anvil_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 "$(cat "$ROOT/scripts/multicall3.hex")" \
      --rpc-url "$RPC" >/dev/null
  fi
  echo "→ test USDC, Morpho Blue + v4 PoolManager (Base Sepolia's own on a fork), MockHyperCore"
  START_PRICE_USD6=217000000 infra
  echo "→ DeployRemote.s.sol: gateway, hook, vault, NaiveLiquidator, PoolSeeder, router"
  deploy
  echo "→ CreateMarkets.s.sol (no IRM), SeedPool.s.sol (thin weekend pool for market A, deep pool for the vault)"
  START_PRICE_USD6=217000000 markets
  NETWORK=$NETWORK THIN=true USDC_AMOUNT=2000000000 PRICE_USD6=217000000 forge_script SeedPool.s.sol
  NETWORK=$NETWORK THIN=false USDC_AMOUNT=200000000000 PRICE_USD6=217000000 forge_script SeedPool.s.sol
  echo "→ RemoteActors.s.sol: LP deposit, lender, borrower"
  # the lender's supply covers several `round`s of borrowing
  PRICE_USD6=217000000 LENDER_SUPPLY=${LENDER_SUPPLY:-2000000000} actors
  cast rpc evm_setIntervalMining 1 --rpc-url "$RPC" >/dev/null # 1 s blocks from here on
  echo "✓ local Base stack up: $DEP_JSON"
  echo "  next: relayer (own terminal), activate, risk-engine:stub, keeper (own terminal), then price <usd>"
}

# ─── run ─────────────────────────────────────────────────────────────────────

relayer() {
  single relayer
  cd "$ROOT"
  if sim; then
    NETWORK=$NETWORK RPC_URL=$RPC RELAYER_PK=$RELAYER_PK BACKEND=mock HEARTBEAT_MS=${HEARTBEAT_MS:-3000} \
      SETTLE_DELAY_MS=0 exec pnpm --silent --filter @seiz3/relayer start
  fi
  : "${HEDGE_PK:?set BASE_HEDGE_PRIVATE_KEY (the hedge account on HyperCore) in .env.local}"
  NETWORK=$NETWORK RPC_URL=$RPC RELAYER_PK=$RELAYER_PK BACKEND=hyperliquid HL_PRIVATE_KEY=$HEDGE_PK HL_ACCOUNT=$HEDGE \
    HEARTBEAT_MS=${HEARTBEAT_MS:-10000} exec pnpm --silent --filter @seiz3/relayer start
}

# the vault starts counting the hedge account's HyperCore USDC once the gateway has seen the account
activate() {
  local vault gateway
  vault=$(json "$DEP_JSON" vault)
  gateway=$(json "$DEP_JSON" hyperCoreGateway)
  until [[ $(call "$gateway" "coreUserExists(address)(bool)" "$vault") == true ]]; do
    echo "waiting for the relayer's first snapshot of $HEDGE (scripts/base-stack.sh $NET relayer)…"
    sleep 3
  done
  send "$vault" "activateCore(uint256)" 0
  echo "vault counts the hedge account: coreUsdc $(usd "$(call "$vault" "coreUsdc()(uint256)")") USDC," \
    "totalAssets $(usd "$(call "$vault" "totalAssets()(uint256)")")"
}

keeper() {
  single keeper
  cd "$ROOT"
  # no USDC route to HyperCore from Base: top-ups and withdrawals stay out of reach (the vault reverts NoBridge).
  # Its own ask-request and watch files: the HyperEVM docker stack reads deployments/ASK_REQUEST.json and watch.json.
  # On sepolia the HyperCore buy-back gate is on (HL_INFO_API_URL): it asks the Base market maker for an ask first.
  if [[ $NET == sepolia ]]; then
    export HL_INFO_API_URL=${HL_INFO_API_URL:-https://api.hyperliquid-testnet.xyz/info}
  else
    unset HL_INFO_API_URL # MockHyperCore fills everything; the keeper's env must not see an empty URL
  fi
  RPC_URL=$RPC KEEPER_PK=${KEEPER_PK:?set KEEPER_PRIVATE_KEY in .env.local} DEPLOYMENTS_PATH=$DEP_JSON \
    KILL_SWITCH_FILE=$ROOT/deployments/BASE_KILL ASK_REQUEST_FILE=$ROOT/deployments/BASE_ASK_REQUEST.json \
    WATCH_FILE=$ROOT/deployments/BASE_watch.json \
    MORPHO_API_ENABLED=0 IDLE_RESERVE_USDC=1000000000 \
    CORE_RESERVE_USDC=1000000000 MIN_SIGNER_BALANCE_WEI=${MIN_SIGNER_BALANCE_WEI:-10000000000000} \
    MAX_ACTIONS_PER_MINUTE=${MAX_ACTIONS_PER_MINUTE:-60} TICK_MS=${TICK_MS:-1000} \
    BUYER_WINDOW_SEC=${BUYER_WINDOW_SEC:-$([[ $NET == sepolia ]] && echo 60 || echo 0)} \
    exec pnpm --silent --filter @seiz3/keeper start
}
# BUYER_WINDOW_SEC (sepolia: 60): each liquidation's stock goes to buyers through the v4 hook before the keeper pushes
# any of it into the pool; the first hook fill (or the end of the window) lets the pushes start

# The Base vault's bots. The market maker trades its OWN account (BASE_MM_PRIVATE_KEY), never the HyperEVM stack's
# (HL_MM_PRIVATE_KEY / HL_MM_ACCOUNT, which the docker bots already quote with): two makers on one account would
# cancel each other's orders.
#   oracle  markets A/B/C follow HyperCore's oracle (the gateway's), so a borrow at the limit tips over on interest
#   pool    the v4 pool on the oracle; while the vault holds stock, just over the hook's ask (POOL_ABOVE_ASK_BPS), so a
#           buyer's swap (yours on /try included) is filled from the vault through the hook
#   mm      quotes xyz:NVDA on HyperCore: the bid the vault's shorts sell into, the asks its buy-backs fill against
#   buyer   buys once from every liquidation's stock through the hook (BUYER_EACH_LIQUIDATION), inside the keeper's
#           buyer window: every liquidation shows a buyer fill as well as pool pushes
#   util    holds market C at its rate model's 90% target utilization (UTIL_FREE_USDC left free to borrow): ~7% APR,
#           so a borrow at the limit tips over ~15 s after it's quoted, not after a minute or more
bots() {
  single bots
  cd "$ROOT"
  local which=${BOTS:-oracle,pool,buyer,util,alerts}
  [[ -n ${BASE_MM_PRIVATE_KEY:-} && -z ${BOTS:-} ]] && which=oracle,pool,mm,buyer,util,alerts
  RPC_URL=$RPC NETWORK=$NETWORK DEPLOYMENTS_PATH=$DEP_JSON HOLD_FILE=$HOLD_FILE BOTS=$which \
    ASK_REQUEST_FILE=$ROOT/deployments/BASE_ASK_REQUEST.json \
    HL_MM_PRIVATE_KEY=${BASE_MM_PRIVATE_KEY:-} HL_MM_ACCOUNT= \
    MM_SPREAD_BPS=${MM_SPREAD_BPS:-30} MM_SIZE=${MM_SIZE:-1.2} \
    BUYER_EACH_LIQUIDATION=${BUYER_EACH_LIQUIDATION:-1} POOL_ABOVE_ASK_BPS=${POOL_ABOVE_ASK_BPS:-5} \
    UTIL_FREE_USDC=${UTIL_FREE_USDC:-400} \
    DEPLOYER_PRIVATE_KEY=$DEPLOYER_PK exec pnpm --filter @seiz3/bots start
}

# The dashboard's data (packages/api) for this deployment, on its own port and watch file (the HyperEVM docker API
# serves 8787 and reads deployments/watch.json). The faucet relay uses FAUCET_OPERATOR_PRIVATE_KEY from .env.local.
api() {
  [[ $NET != fork ]] || { echo "api runs on local or sepolia" >&2; exit 1; }
  cd "$ROOT"
  NETWORK=$NETWORK RPC_URL=$RPC DEPLOYMENTS_PATH=$DEP_JSON API_PORT=${API_PORT:-8788} \
    WATCH_FILE=$ROOT/deployments/BASE_watch.json LOG_PAGE=${LOG_PAGE:-2000} \
    FAUCET_IP_COOLDOWN_SEC=${FAUCET_IP_COOLDOWN_SEC:-120} \
    exec pnpm --silent --filter @seiz3/api exec tsx src/index.ts # no watch mode: a crash exits, and `live` restarts it
  # FAUCET_IP_COOLDOWN_SEC 120: try several wallets from one machine (the Faucet contract still allows one drip per
  # address per 10 minutes)
}

# The dashboard and /try page for this deployment, on :3001 (the HyperEVM docker web is on :3000)
web() {
  [[ $NET == sepolia ]] || { echo "web runs against Base Sepolia" >&2; exit 1; }
  cd "$ROOT"
  NEXT_PUBLIC_NETWORK=base-sepolia NEXT_PUBLIC_API_URL=http://localhost:${API_PORT:-8788} \
    NEXT_PUBLIC_RPC_URL=${NEXT_PUBLIC_RPC_URL:-https://sepolia.base.org} DEPLOYMENTS_PATH=$DEP_JSON \
    exec pnpm --filter @seiz3/web exec next dev --port "${WEB_PORT:-3001}"
}

# live: every service this deployment needs, in one terminal: risk engine, relayer, keeper, bots, Chainlink CRE loop,
# API and web. Each logs to deployments/base-logs/<name>.log (`logs <name>` follows one); Ctrl-C stops them all.
live() {
  [[ $NET == sepolia ]] || { echo "live runs against Base Sepolia" >&2; exit 1; }
  local port
  for port in "${WEB_PORT:-3001}" "${API_PORT:-8788}" 8081 9090; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $port is already in use: another Seiz3 stack is running (Ctrl-C it, or pnpm base:down for" \
        "the docker one, first)" >&2
      exit 1
    fi
  done
  single live
  local logs=$ROOT/deployments/base-logs pids=() name
  mkdir -p "$logs"
  set -m # each service in its own process group, so stopping one stops its node children too
  # supervised: a service that exits (a startup check that hit a flaky RPC, a crash) is restarted 5 s later
  start() {
    name=$1
    shift
    (
      set +e # the script's `set -e` would end this loop with the first failed run instead of restarting it
      while true; do
        "$@"
        echo "[live] $name exited ($?): restarting in 5 s"
        sleep 5
      done
    ) >>"$logs/$name.log" 2>&1 &
    pids+=($!)
    echo "  started $name (log: deployments/base-logs/$name.log)"
  }
  stop() {
    echo "stopping…"
    for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    sleep 2
    # next dev's server can outlive its process group: free the ports this stack opened
    local port
    for port in "${WEB_PORT:-3001}" "${API_PORT:-8788}"; do
      lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill -TERM 2>/dev/null || true
    done
    mm_cancel || true
    rm -f "$ROOT/deployments/.$NETWORK-live.pid"
    exit 0
  }
  trap stop INT TERM
  echo "Seiz3 on Base Sepolia: vault $(json "$DEP_JSON" vault), hedge account $HEDGE"
  start risk-engine pnpm --filter @seiz3/keeper risk-engine:stub
  start relayer "$0" sepolia relayer
  start api "$0" sepolia api
  start web "$0" sepolia web
  until [[ $(call "$(json "$DEP_JSON" hyperCoreGateway)" "fresh()(bool)" 2>/dev/null) == true ]]; do sleep 2; done
  echo "  relayer is posting HyperCore state to the gateway"
  start keeper "$0" sepolia keeper
  start bots "$0" sepolia bots
  start cre "$0" sepolia cre-loop
  echo
  echo "→ http://localhost:${WEB_PORT:-3001}/try   (your wallet: lend, borrow, watch the liquidation and the unwind)"
  echo "→ http://localhost:${WEB_PORT:-3001}       (dashboard: markets, vault, HyperCore short, operations)"
  echo "Ctrl-C stops everything. In another terminal: scripts/base-stack.sh sepolia logs keeper|relayer|bots|cre|api|web"
  wait
}

logs() {
  local f=$ROOT/deployments/base-logs/${1:?usage: logs keeper|relayer|bots|cre|api|web|risk-engine}.log
  [[ -f $f ]] || { echo "no $f: start 'live' first" >&2; exit 1; }
  exec tail -n 40 -F "$f"
}

# ─── demo moves ──────────────────────────────────────────────────────────────

# price <usd> (local): market C's lending oracle and HyperCore's oracle/mark together; the relayer reports it
price() {
  sim || { echo "price is local only: HyperCore testnet's oracle can't be moved (use crash)" >&2; exit 1; }
  local usd6
  usd6=$(cast parse-units "${1:?usage: price <usd>}" 6)
  send "$(json "$DEP_JSON" markets.C_seiz3.oracle)" "setPrice(uint256)" "${usd6}000000000000000000"
  send "$(json "$INFRA_JSON" core)" "setPx(uint64)" "$((usd6 / 10 ** SZ_DECIMALS))"
  echo "NVDA = \$$1 on market C's oracle and on (mock) HyperCore; the relayer's next snapshot carries it"
}

# pool_to <usd6>: the vault's hooked pool arbitraged to that price through PoolSeeder (the deployer pays)
pool_to() {
  local px=$1 sqrt key c0 nvdax_is0 seeder max
  seeder=$(json "$DEP_JSON" poolSeeder)
  max=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
  c0=$(json "$DEP_JSON" poolKey.currency0)
  [[ $(tr '[:upper:]' '[:lower:]' <<<"$c0") == $(tr '[:upper:]' '[:lower:]' <<<"$(json "$DEP_JSON" nvdax)") ]] &&
    nvdax_is0=true || nvdax_is0=false
  sqrt=$(sqrt_limit "$px" "$nvdax_is0")
  key="($c0,$(json "$DEP_JSON" poolKey.currency1),$(json "$DEP_JSON" poolKey.fee),$(json "$DEP_JSON" poolKey.tickSpacing),$(json "$DEP_JSON" poolKey.hooks))"
  local token
  for token in "$(json "$DEP_JSON" usdc)" "$(json "$DEP_JSON" nvdax)"; do
    # SeedPool approves exact amounts, so either token can be left at (or near) zero; an unlimited approval stays
    [[ $(call "$token" "allowance(address,address)(uint256)" "$DEPLOYER" "$seeder") == \
      115792089237316195423570985008687907853269984665640564039457584007913129639935 ]] ||
      send "$token" "approve(address,uint256)" "$seeder" "$max"
  done
  send "$(json "$DEP_JSON" nvdax)" "mint(address,uint256)" "$DEPLOYER" 100000000000000000000
  send "$seeder" "swapToPrice((address,address,uint24,int24,address),uint160)" "$key" "$sqrt"
}

# weekend (local): market closed, and the vault's pool still above Friday's close: over the hook's ask and outside the
# vault's oracle band, so buyers are filled from the vault by the hook while the keeper can't push stock into the pool
weekend() {
  sim || { echo "weekend is local only" >&2; exit 1; }
  local px
  px=$(oracle_usd6)
  send "$(json "$DEP_JSON" riskParams)" "setMarketOpen(bool)" false
  pool_to $((px * 10300 / 10000))
  echo "weekend: market closed, pool at \$$(usd $((px * 10300 / 10000))) (HyperCore \$$(usd "$px") + 3%)"
}

# monday [usd] (local): market open, and the vault's pool arbitraged back onto HyperCore's oracle
monday() {
  sim || { echo "monday is local only (on sepolia the bots' pool rebalancer does it)" >&2; exit 1; }
  local px
  px=$(oracle_usd6)
  [[ -n ${1:-} ]] && px=$(cast parse-units "$1" 6)
  pool_to "$px"
  send "$(json "$DEP_JSON" riskParams)" "setMarketOpen(bool)" true
  echo "Monday: market open, pool at \$$(usd "$px"): the keeper unwinds"
}

crash() {
  local live target threshold oracle
  live=$(oracle_usd6)
  target=$((live * (10000 - CRASH_BPS) / 10000))
  threshold=$(($(json "$DEP_JSON" demo.borrowPriceUsd6) * LTV_BPS / 7700))
  if ((target >= threshold)); then
    echo "NVDA rose on HyperCore since the borrow: \$$(usd "$target") wouldn't make the borrower liquidatable" \
      "(needs < \$$(usd "$threshold")) and anything lower is outside the oracle band; borrow again first" >&2
    exit 1
  fi
  oracle=$(json "$DEP_JSON" markets.C_seiz3.oracle)
  echo crash >"$HOLD_FILE" # or the bots' oracle follower puts it straight back
  send "$oracle" "setPrice(uint256)" "${target}000000000000000000"
  echo "market C oracle \$$(usd "$target"), HyperCore \$$(usd "$live"): the keeper should liquidate"
}

release() {
  rm -f "$HOLD_FILE"
  echo "bots released: the oracles follow HyperCore again"
}

# borrow <nvdax>: the next round's market C borrower (the deployer) just under the LLTV at HyperCore's price
borrow() {
  local amount=${1:?usage: borrow <nvdax>} px morpho id params nvdax wei pos mkt amt
  px=$(oracle_usd6)
  send "$(json "$DEP_JSON" markets.C_seiz3.oracle)" "setPrice(uint256)" "${px}000000000000000000"
  morpho=$(json "$DEP_JSON" morpho)
  id=$(json "$DEP_JSON" markets.C_seiz3.id)
  params="($(cast call "$morpho" "idToMarketParams(bytes32)(address,address,address,address,uint256)" "$id" \
    --rpc-url "$RPC" | awk '{print $1}' | paste -sd, -))"
  nvdax=$(json "$DEP_JSON" nvdax)
  wei=$(cast to-wei "$amount")
  send "$nvdax" "mint(address,uint256)" "$DEPLOYER" "$wei"
  send "$nvdax" "approve(address,uint256)" "$morpho" "$wei"
  send "$morpho" "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)" "$params" "$wei" \
    "$DEPLOYER" 0x
  pos=$(cast call "$morpho" "position(bytes32,address)(uint256,uint128,uint128)" "$id" "$DEPLOYER" --rpc-url "$RPC" |
    awk '{print $1}' | paste -sd' ' -)
  mkt=$(cast call "$morpho" "market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)" "$id" --rpc-url "$RPC" |
    awk '{print $1}' | paste -sd' ' -)
  amt=$(node -e '
    const [, borrowShares, collateral] = process.argv[1].split(" ").map(BigInt);
    const [supply, , borrowed, totalShares] = process.argv[2].split(" ").map(BigInt);
    const [px, ltv] = [BigInt(process.argv[3]), BigInt(process.argv[4])];
    const debt = totalShares === 0n ? 0n : (borrowShares * borrowed + totalShares - 1n) / totalShares;
    const want = (collateral * px) / 10n ** 18n * ltv / 10_000n - debt;
    const room = supply - borrowed;
    console.log(String(want < 0n ? 0n : want < room ? want : room));
  ' "$pos" "$mkt" "$px" "$LTV_BPS")
  [[ $amt == 0 ]] && { echo "nothing to borrow: already at ${LTV_BPS} bps, or the market has no idle USDC" >&2; exit 1; }
  send "$morpho" "borrow((address,address,address,address,uint256),uint256,uint256,address,address)" "$params" "$amt" 0 \
    "$DEPLOYER" "$DEPLOYER"
  borrowers "$px" "$DEPLOYER:C_seiz3"
  echo "borrowed \$$(usd "$amt") at \$$(usd "$px") (${LTV_BPS} bps): next, crash"
}

# sqrt_limit <usdc-per-nvdax usd6> <nvdax is currency0>: the pool's sqrtPriceX96 at that price
sqrt_limit() {
  node -e '
    const [px, nvdaxIs0] = [BigInt(process.argv[1]), process.argv[2] === "true"];
    const sqrt = (n) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    const Q192 = 1n << 192n;
    console.log(String(nvdaxIs0 ? sqrt((px * Q192) / 10n ** 18n) : sqrt((10n ** 18n * Q192) / px)));
  ' "$1" "$2"
}

# hook-fill <usdc> [push-max-usdc]: as scripts/testnet-stack.sh — push the curve just past the hook's ask, then buy
# <usdc> of NVDAx, which the hook fills from the vault's hedged stock. Its buy-back goes out through the relayer.
hook_fill() {
  local usdc=$((${1:?usage: hook-fill <usdc> [push-max-usdc]} * 1000000)) push=$((${2:-100} * 1000000))
  local hook router usdc_addr c0 key cap ask fee open nvdax_is0 zfo lim_push lim_fill nonce tx1 tx2 fill
  hook=$(json "$DEP_JSON" hook)
  router=$(json "$DEP_JSON" swapRouter)
  usdc_addr=$(json "$DEP_JSON" usdc)
  c0=$(json "$DEP_JSON" poolKey.currency0)
  key="($c0,$(json "$DEP_JSON" poolKey.currency1),$(json "$DEP_JSON" poolKey.fee),$(json "$DEP_JSON" poolKey.tickSpacing),$hook)"
  read -r cap ask fee open <<<"$(cast call "$hook" "quote()(uint256,uint256,uint24,bool)" --rpc-url "$RPC" |
    awk '{print $1}' | paste -sd' ' -)"
  echo "hook quote: ask \$$(usd "$ask"), fee $((fee / 100)) bps, market open $open, vault can sell $(cast format-units "$cap" 18) NVDAx"
  [[ $(call "$(json "$DEP_JSON" vault)" "inventory()(uint256)") == 0 ]] && { echo "the vault holds no stock to sell" >&2; exit 1; }
  if [[ $(tr '[:upper:]' '[:lower:]' <<<"$c0") == $(tr '[:upper:]' '[:lower:]' <<<"$usdc_addr") ]]; then
    nvdax_is0=false zfo=true
  else
    nvdax_is0=true zfo=false
  fi
  send "$usdc_addr" "approve(address,uint256)" "$router" $((push + usdc))
  nonce=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
  if [[ $cap == 0 ]]; then
    # the pool trades under the ask (the bots hold it on the oracle): a price-limited buy moves it just past the ask
    # first, then the buy the hook fills; back to back, so nothing pulls the pool down in between
    lim_push=$(sqrt_limit $((ask * 10005 / 10000)) $nvdax_is0)
    lim_fill=$(sqrt_limit $((ask * 10050 / 10000)) $nvdax_is0)
    tx1=$(cast send --async --nonce "$nonce" --gas-limit 900000 "$router" \
      "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)" "$key" "($zfo,-$push,$lim_push)" \
      "(false,false)" 0x --private-key "$DEPLOYER_PK" --rpc-url "$RPC")
    nonce=$((nonce + 1))
    echo "push to the ask: $tx1 → $(cast receipt "$tx1" status --rpc-url "$RPC")"
  else
    # the pool already trades at or above the ask (the weekend pool at Friday's price): the hook fills straight away;
    # the limit only caps what the curve may charge for anything the hook can't take
    lim_fill=$(sqrt_limit $((ask * 2)) $nvdax_is0)
  fi
  tx2=$(cast send --async --nonce "$nonce" --gas-limit 1500000 "$router" \
    "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)" "$key" "($zfo,-$usdc,$lim_fill)" \
    "(false,false)" 0x --private-key "$DEPLOYER_PK" --rpc-url "$RPC")
  echo "buy:             $tx2 → $(cast receipt "$tx2" status --rpc-url "$RPC")"
  fill=$(cast receipt "$tx2" --json --rpc-url "$RPC" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const topic = process.argv[1].toLowerCase(), hook = process.argv[2].toLowerCase();
    const log = r.logs.find((l) => l.address.toLowerCase() === hook && l.topics[0].toLowerCase() === topic);
    if (!log) { console.log("none"); process.exit(0); }
    const w = log.data.slice(2).match(/.{64}/g).map((h) => BigInt("0x" + h));
    console.log(`${Number(w[0]) / 1e18} NVDAx for ${Number(w[1]) / 1e6} USDC at $${Number(w[2]) / 1e6}`);
  ' "$(cast keccak "InventoryFill(address,uint256,uint256,uint256,bool)")" "$hook")
  echo "hook fill from the vault: $fill (the relayer buys back the matching short, the keeper syncs)"
}

status() {
  local vault gateway usdc snap now
  vault=$(json "$DEP_JSON" vault)
  gateway=$(json "$DEP_JSON" hyperCoreGateway)
  usdc=$(json "$DEP_JSON" usdc)
  now=$(cast block latest -f timestamp --rpc-url "$RPC")
  snap=$(cast call "$gateway" "lastSnapshot()((uint64,int64,uint64,int64,uint64,uint64,uint64,uint64,uint64,uint32,bool,uint64))" \
    --rpc-url "$RPC" | tr -d '()' | tr ',' ' ')
  read -r at szi _ value _ _ _ opx _ _ exists ack <<<"$(awk '{for (i = 1; i <= NF; i++) if ($i !~ /^\[/) printf "%s ", $i}' <<<"$snap")"
  echo "vault        $vault ($NETWORK)"
  echo "gateway      $gateway  orders=$(call "$gateway" "actionCount()(uint64)") acked=$ack settled=$(call "$gateway" "settled()(bool)")"
  echo "hedge acct   $HEDGE  szi=$szi  xyz value=\$$(usd "${value:-0}")  oracle=\$$(usd $((${opx:-0} * 10 ** SZ_DECIMALS)))  exists=$exists  age=$((now - ${at:-0}))s"
  echo "vault        idle=$(usd "$(call "$usdc" "balanceOf(address)(uint256)" "$vault")") USDC  inventory=$(cast format-units \
    "$(call "$vault" "inventory()(uint256)")" 18)  confirmedShort=$(call "$vault" "confirmedShort()(int64)")" \
    " pending=$(cast call "$vault" "pendingHedge()(int64,uint64,uint64,uint8)" --rpc-url "$RPC" | head -1)  paused=$(call "$vault" "paused()(bool)")"
  echo "prices       market C=\$$(cast format-units "$(call "$(json "$DEP_JSON" markets.C_seiz3.oracle)" "price()(uint256)")" 24)" \
    " market open=$(call "$(json "$DEP_JSON" riskParams)" "marketOpen()(bool)")"
}

# mm-cancel: the market maker's quotes rest on HyperCore after its bot stops: take them down (live's Ctrl-C, base:down)
mm_cancel() {
  [[ -n ${BASE_MM_PRIVATE_KEY:-} ]] || return 0
  (cd "$ROOT" && HL_PRIVATE_KEY=$BASE_MM_PRIVATE_KEY pnpm --silent --filter @seiz3/relayer admin cancel-all)
}

hedge_admin() {
  : "${HEDGE_PK:?set BASE_HEDGE_PRIVATE_KEY in .env.local}"
  (cd "$ROOT" && HL_PRIVATE_KEY=$HEDGE_PK HL_ACCOUNT=$HEDGE pnpm --silent --filter @seiz3/relayer admin "$@")
}

# packages/cre/base-feed/config.base-sepolia.json: the testnet feed's config (market hours, Data Feed check, the book)
# pointed at this deployment's RiskParams on Base Sepolia, plus the gateway block that turns on the hedge attestation
cre_config() {
  node -e '
    const fs = require("fs");
    const [stagingPath, depPath, out] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(stagingPath, "utf8"));
    const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
    // readBlock latest: the finalized head of Base Sepolia trails by hours, so a fresh RiskParams is not there yet
    c.evm = { chainSelectorName: "ethereum-testnet-sepolia-base-1", isTestnet: true, riskParams: dep.riskParams, gasLimit: "300000", readBlock: "latest" };
    // market status from Chainlink Data Streams: NVDA/USD regular-hours stream (RWA Advanced, v11: marketStatus plus
    // the equity top of book) on the testnet Data Engine, which our credentials are authorized for
    c.marketStatus = "dataStreams";
    c.dataStreams = {
      apiUrl: "https://api.testnet-dataengine.chain.link",
      feedId: process.env.DS_FEED_ID || "0x000b1d444945231e44dd47736c6abe288b10cb1b53941c7c68012fbdd2b1755c",
    };
    c.gateway = { address: dep.hyperCoreGateway, hedgeAccount: dep.hedgeAccount, szDecimals: dep.hypercore.szDecimals, gasLimit: "400000" };
    fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n");
  ' "$ROOT/packages/cre/market-feed/config.staging.json" "$DEP_JSON" "$ROOT/packages/cre/base-feed/config.base-sepolia.json"
}

# One run of the CRE workflow with the Base Sepolia config: RiskParams + the DON's snapshot of the hedge account to the
# gateway. --broadcast sends both reports through Base Sepolia's simulation forwarder (CRE_PRIVATE_KEY pays the gas).
cre_feed() {
  [[ $NET != local ]] || { echo "cre needs Base Sepolia's Chainlink forwarder: sepolia, or a fork of it" >&2; exit 1; }
  local cli target=base-sepolia-settings
  [[ $NET == fork ]] && target=base-fork-settings # the same chain selector, its RPC pointed at the fork
  cli=$(command -v cre || echo "$HOME/.cre/bin/cre")
  cre_config
  # Data Streams credentials from .env.local: DATA_STREAMS_API_KEY + DATA_STREAMS_USER_SECRET (Chainlink's testnet
  # access), else the older DATA_STREAM_USERNAME + HMAC_SECRET
  (cd "$ROOT/packages/cre" &&
    DATA_STREAMS_API_KEY=${DATA_STREAMS_API_KEY:-${DATA_STREAM_USERNAME:-}} \
      DATA_STREAMS_API_SECRET=${DATA_STREAMS_USER_SECRET:-${HMAC_SECRET:-}} \
      CRE_ETH_PRIVATE_KEY=${CRE_PRIVATE_KEY:-$DEPLOYER_PK} \
      "$cli" workflow simulate base-feed --target "$target" --non-interactive --trigger-index 0 "$@")
}

# cre-off: RiskParams ignores the feed and the owner's values apply; cre-on [age]: back on (default 300 s)
cre_age() {
  send "$(json "$DEP_JSON" riskParams)" "setMaxReportAge(uint32)" "$1"
  echo "RiskParams maxReportAge=$(call "$(json "$DEP_JSON" riskParams)" "maxReportAge()(uint32)")s," \
    "marketOpen=$(call "$(json "$DEP_JSON" riskParams)" "marketOpen()(bool)")"
}

cre_loop() {
  local interval=${CRE_INTERVAL_SEC:-60} out line
  echo "CRE feed every ${interval}s → RiskParams $(json "$DEP_JSON" riskParams) + gateway $(json "$DEP_JSON" hyperCoreGateway)"
  set +e
  while true; do
    out=$(cre_feed --broadcast 2>&1)
    line=$(grep -E "Seiz3 market feed:|workflow execution failed" <<<"$out" | tail -1 | sed -E 's/^.*\] //')
    echo "$(date -u +%H:%M:%S) ${line:-no result: $(grep -v '^[[:space:]]*$' <<<"$out" | tail -1 | cut -c1-200)}"
    sleep "$interval"
  done
}

# ─── round (local): the whole demo, checked, against the running relayer and keeper ──────────────────────────────

wait_for() { # wait_for <seconds> <description> <command…>
  local secs=$1 what=$2
  shift 2
  for ((i = 0; i < secs; i++)); do
    if "$@" >/dev/null 2>&1; then echo "  ✓ $what (${i}s)"; return 0; fi
    sleep 1
  done
  echo "  ✗ $what: not after ${secs}s" >&2
  status >&2
  exit 1
}

holds_stock() { [[ $(call "$(json "$DEP_JSON" vault)" "inventory()(uint256)") != 0 ]]; }
hedged() {
  local v
  v=$(json "$DEP_JSON" vault)
  [[ $(cast call "$v" "pendingHedge()(int64,uint64,uint64,uint8)" --rpc-url "$RPC" | head -1) == 0 &&
    $(call "$v" "confirmedShort()(int64)") != 0 ]]
}
flat() {
  local v
  v=$(json "$DEP_JSON" vault)
  [[ $(call "$v" "inventory()(uint256)") == 0 && $(call "$v" "confirmedShort()(int64)") == 0 &&
    $(cast call "$v" "pendingHedge()(int64,uint64,uint64,uint8)" --rpc-url "$RPC" | head -1) == 0 ]]
}
quiet() { # hedged, and the keeper is done liquidating: the vault's stock hasn't moved for 5 s
  local before
  hedged || return 1
  before=$(call "$(json "$DEP_JSON" vault)" "inventory()(uint256)")
  sleep 5
  hedged && [[ $(call "$(json "$DEP_JSON" vault)" "inventory()(uint256)") == "$before" ]]
}
bought_back() { # the short shrank below what it was after the liquidation
  local v
  v=$(json "$DEP_JSON" vault)
  [[ $(cast call "$v" "pendingHedge()(int64,uint64,uint64,uint8)" --rpc-url "$RPC" | head -1) == 0 &&
    $(call "$v" "confirmedShort()(int64)") -gt ${SHORT_AFTER_LIQ:-0} ]]
}

round() {
  sim || { echo "round is local only: on sepolia step through crash / hook-fill by hand" >&2; exit 1; }
  flat || { echo "the vault isn't flat yet: wait for the last round's unwind (status)" >&2; exit 1; }
  echo "round: weekend → borrow → crash → liquidate → short via relayer → hook fill → Monday unwind → flat"
  # the weekend pool first, while the vault holds no stock: moving the pool up is a buy the hook would fill
  weekend
  borrow "${ROUND_NVDAX:-1}"
  crash
  wait_for 90 "keeper liquidated market C (vault holds stock)" holds_stock
  wait_for 90 "relayer placed the short, keeper's syncHedge confirmed it" hedged
  # a thin vault can take a borrower in more than one liquidation (each capped by its idle USDC)
  wait_for 120 "keeper done liquidating, every short confirmed" quiet
  SHORT_AFTER_LIQ=$(call "$(json "$DEP_JSON" vault)" "confirmedShort()(int64)")
  echo "  short on (mock) HyperCore: $SHORT_AFTER_LIQ units"
  release
  local fill
  fill=$(hook_fill 20 | tee /dev/stderr | grep "hook fill from the vault")
  [[ $fill != *": none "* ]] || { echo "  ✗ the hook sold nothing from the vault" >&2; status >&2; exit 1; }
  echo "  ✓ a buyer was filled from the vault by the hook"
  wait_for 90 "hook fill's buy-back relayed and confirmed" bought_back
  monday
  wait_for 600 "keeper unwound to flat (stock sold, short closed)" flat
  status
  echo "✓ round complete"
}

case $CMD in
  up) up ;;
  infra) infra ;;
  deploy) deploy ;;
  markets) markets ;;
  seed) seed "${1:-}" "${2:-}" ;;
  actors) actors ;;
  extras) extras ;;
  relayer) relayer ;;
  activate) activate ;;
  keeper) keeper ;;
  bots) bots ;;
  api) api ;;
  web) web ;;
  live) live ;;
  logs) logs "${1:-}" ;;
  price) price "${1:-}" ;;
  monday) monday "${1:-}" ;;
  weekend) weekend ;;
  crash) crash ;;
  release) release ;;
  borrow) borrow "${1:-}" ;;
  hook-fill) hook_fill "${1:-}" "${2:-}" ;;
  status) status ;;
  hedge-status) hedge_admin status ;;
  mm-cancel) mm_cancel ;;
  to-xyz) hedge_admin to-xyz "${1:?usage: to-xyz <usdc>}" ;;
  from-xyz) hedge_admin from-xyz "${1:?usage: from-xyz <usdc>}" ;;
  cre) cre_feed "$@" ;;
  cre-loop) cre_loop ;;
  cre-off) cre_age 0 ;;
  cre-on) cre_age "${1:-300}" ;;
  round) round ;;
  *)
    echo "usage: scripts/base-stack.sh local|sepolia up | infra | deploy | markets | seed deep|thin <usdc> | actors |" \
      "relayer | activate | keeper | bots | price <usd> | monday [usd] | crash | release | borrow <nvdax> |" \
      "hook-fill <usdc> [push] | status | hedge-status | to-xyz <usdc> | from-xyz <usdc> | cre [--broadcast] |" \
      "cre-loop | round" >&2
    exit 1
    ;;
esac
