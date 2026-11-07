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
#   scripts/testnet-stack.sh fund-core       # HL_FUNDER_PRIVATE_KEY sends 120 USDC (spot) to the vault on HyperCore
#   … and post a bid ≥ 1 NVDA on xyz:NVDA near the oracle (the bots' market maker does)
#   scripts/testnet-stack.sh sweep           # the vault's spot USDC → xyz margin
#   scripts/testnet-stack.sh status
#   pnpm --filter @seiz3/keeper risk-engine:stub   # its own terminal
#   scripts/testnet-stack.sh keeper                    # its own terminal
#   scripts/testnet-stack.sh crash           # market C oracle 1.4% under HyperCore's: the keeper liquidates and hedges
#   scripts/testnet-stack.sh release         # after the liquidation: the bots move market C back to HyperCore's price
#   scripts/testnet-stack.sh borrow <nvdax>  # the next round's borrower, just under the LLTV; then crash again
#   scripts/testnet-stack.sh hook-fill <usdc> # a buyer filled by the v4 hook from the vault's hedged stock
#   scripts/testnet-stack.sh cre [--broadcast]   # one run of the Chainlink CRE market feed → RiskParams (`cre login` once)
#   scripts/testnet-stack.sh cre-loop            # a report every minute, as a DON would: keep it running for the demo
#   scripts/testnet-stack.sh cre-status          # the last report, its age, and what the vault reads from it
#   scripts/testnet-stack.sh cre-off | cre-on    # ignore the feed (the owner's values) | use it again
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
HOLD_FILE=$ROOT/deployments/BOTS_HOLD # while it exists the market oracle follower stands still (the pool bot doesn't)
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
  (cd "$ROOT" && pnpm --silent --filter @seiz3/bots hl-admin big-blocks "$1")
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
    dep.borrowers = [{ address, label: "C_seiz3" }];
    dep.demo = { borrowPriceUsd6: px };
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$DEPLOYER" "$px"
  # coreFunded makes the vault count its Core USDC. Only a CoreDepositWallet deposit sets it, and on testnet that
  # deposit is never credited, so this costs 1 USDC.
  send "$vault" "activateCore(uint256)" 1000000
  echo "borrower $DEPLOYER at \$$(cast format-units "$px" 6), coreFunded $(cast call "$vault" "coreFunded()(bool)" --rpc-url "$RPC")"
  echo "next: fund-core (or Send $CORE_MARGIN_USDC USDC (spot) to $vault on app.hyperliquid-testnet.xyz), then: sweep"
}

# the vault's margin, sent on HyperCore from HL_FUNDER_PRIVATE_KEY's spot USDC (not an API wallet); also creates its HyperCore account
fund_core() {
  : "${HL_FUNDER_PRIVATE_KEY:=${HL_MM_PRIVATE_KEY:?set HL_FUNDER_PRIVATE_KEY (the wallet holding HyperCore USDC) in .env.local}}"
  (cd "$ROOT" && pnpm --silent --filter @seiz3/bots hl-admin send-usdc "$(json "$DEP_JSON" vault)" \
    "${1:-$CORE_MARGIN_USDC}")
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

# faucet-cooldown <seconds>: how often one address may drip (the drip sizes stay as they are)
faucet_cooldown() {
  local cooldown=${1:?usage: faucet-cooldown <seconds>} faucet nvdax usdc native
  faucet=$(json "$DEP_JSON" faucet)
  nvdax=$(call "$faucet" "nvdaxDrip()(uint256)")
  usdc=$(call "$faucet" "usdcDrip()(uint256)")
  native=$(call "$faucet" "nativeDrip()(uint256)")
  send "$faucet" "setDrips(uint256,uint256,uint256,uint64)" "$nvdax" "$usdc" "$native" "$cooldown"
  echo "faucet: $(cast format-units "$nvdax" 18) NVDAx + $(cast format-units "$usdc" 6) USDC + HYPE up to" \
    "$(cast format-units "$native" 18), once per $(call "$faucet" "cooldown()(uint64)") s per address"
}

# RiskParams.Params, in declaration order (contracts/src/RiskParams.sol)
RISK_FIELDS="maxLiquidation maxUnhedged leverage marginBufferBps minDiscountBps oracleBandBps hedgeCapBps maxSlippageBps maxTries orderDelaySec cooldownOpenSec cooldownClosedSec withdrawReserve maxImpactBps transitBlocks"
RISK_TUPLE="(uint256,uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint8,uint32,uint32,uint32,uint256,uint16,uint8)"

# risk-set <field> <value> [<field> <value> …]: change the owner's caps by name; every other field stays as it is
risk_set() {
  [[ $# -ge 2 && $(($# % 2)) == 0 ]] || { echo "usage: risk-set <field> <value> [...] (fields: $RISK_FIELDS)" >&2; exit 1; }
  local rp current next
  rp=$(json "$DEP_JSON" riskParams)
  current=$(cast call "$rp" "params()($RISK_TUPLE)" --rpc-url "$RPC") # one tuple: "(a [1e…], b, …)"
  next=$(node -e '
    const [raw, names, ...pairs] = process.argv.slice(1);
    const fields = names.split(" ");
    const values = raw.replace(/^\(|\)$/g, "").split(", ").map((v) => v.replace(/ \[.*\]$/, ""));
    for (let i = 0; i < pairs.length; i += 2) {
      const at = fields.indexOf(pairs[i]);
      if (at < 0) { console.error(`no RiskParams field ${pairs[i]}`); process.exit(1); }
      console.error(`${pairs[i]}: ${values[at]} → ${pairs[i + 1]}`);
      values[at] = pairs[i + 1];
    }
    console.log(`(${values.join(",")})`);
  ' "$current" "$RISK_FIELDS" "$@")
  send "$rp" "setParams($RISK_TUPLE)" "$next"
}

fund_naive() {
  local naive
  naive=$(json "$DEP_JSON" naiveLiquidator)
  send "$(json "$DEP_JSON" usdc)" "transfer(address,uint256)" "$naive" "$((${1:?usage: fund-naive <usdc>} * 1000000))"
  echo "NaiveLiquidator $naive funded"
}

# borrow <nvdax>: a fresh market C borrower for the next demo round (TestnetActors only runs before the vault's first
# Core deposit). The deployer adds <nvdax> of collateral and borrows up to LTV_BPS of all its market C collateral at
# HyperCore's live price, where the bots hold market C's oracle, so `crash` makes it liquidatable. Bounded by what
# the market can lend; records the borrow price for crash.
borrow() {
  local amount=${1:?usage: borrow <nvdax>} px oracle_px morpho id params nvdax wei pos mkt amt
  [[ -f $HOLD_FILE ]] && { echo "market C's oracle is on hold (after a crash): scripts/testnet-stack.sh release first" >&2; exit 1; }
  px=$(oracle_usd6)
  oracle_px=$(call "$(json "$DEP_JSON" markets.C_seiz3.oracle)" "price()(uint256)")
  # DemoOracle price = usd6 × 1e18: wait for the oracle follower if market C isn't at HyperCore's price yet
  if [[ $oracle_px != "${px}000000000000000000" ]]; then
    echo "market C's oracle isn't at HyperCore's \$$(cast format-units "$px" 6) yet (the bots' oracle follower moves it)" >&2
    exit 1
  fi
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
  # LTV_BPS of the collateral's value, less the debt already owed, capped by the market's idle supply
  amt=$(node -e '
    const [, borrowShares, collateral] = process.argv[1].split(" ").map(BigInt);
    const [supply, , borrowed, totalShares] = process.argv[2].split(" ").map(BigInt);
    const [px, ltv] = [BigInt(process.argv[3]), BigInt(process.argv[4])];
    const debt = totalShares === 0n ? 0n : (borrowShares * borrowed + totalShares - 1n) / totalShares;
    const want = (collateral * px) / 10n ** 18n * ltv / 10_000n - debt;
    const room = supply - borrowed;
    console.log(String(want < 0n ? 0n : want < room ? want : room));
  ' "$pos" "$mkt" "$px" "$LTV_BPS")
  [[ $amt == 0 ]] && { echo "nothing to borrow: the position is already at ${LTV_BPS} bps or the market has no idle USDC" >&2; exit 1; }
  send "$morpho" "borrow((address,address,address,address,uint256),uint256,uint256,address,address)" "$params" "$amt" 0 \
    "$DEPLOYER" "$DEPLOYER"
  node -e '
    const fs = require("fs");
    const [path, px] = process.argv.slice(1);
    const dep = JSON.parse(fs.readFileSync(path, "utf8"));
    dep.demo = { ...dep.demo, borrowPriceUsd6: px };
    fs.writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
  ' "$DEP_JSON" "$px"
  echo "borrowed \$$(cast format-units "$amt" 6) against $(cast format-units "$(cut -d' ' -f3 <<<"$pos")" 18) NVDAx at" \
    "\$$(cast format-units "$px" 6) (${LTV_BPS} bps): next, crash"
}

# sqrt_limit <usdc-per-nvdax usd6> <nvdax is currency0>: the pool's sqrtPriceX96 at that price
sqrt_limit() {
  node -e '
    const [px, nvdaxIs0] = [BigInt(process.argv[1]), process.argv[2] === "true"];
    const sqrt = (n) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    const Q192 = 1n << 192n;
    // token1 per token0 in raw units: NVDAx (18 dec) per USDC (6 dec), or the inverse
    console.log(String(nvdaxIs0 ? sqrt((px * Q192) / 10n ** 18n) : sqrt((10n ** 18n * Q192) / px)));
  ' "$1" "$2"
}

# hook-fill <usdc> [push-max-usdc]: the hook selling the vault's hedged stock to a buyer. The hook only sells while the
# pool trades at or above its ask (oracle + spread), and the pool bot holds the pool on the oracle, so two buys go out
# back to back from the deployer: the first moves the curve just past the ask (a price-limited buy, spending at most
# push-max-usdc, default 100), the second (<usdc>) is filled from the vault at the ask. Then the keeper buys back.
hook_fill() {
  local usdc=$((${1:?usage: hook-fill <usdc> [push-max-usdc]} * 1000000)) push=$((${2:-100} * 1000000))
  local hook router usdc_addr c0 key q cap ask fee open nvdax_is0 zfo lim_push lim_fill nonce tx1 tx2 fill
  hook=$(json "$DEP_JSON" hook)
  router=$(json "$DEP_JSON" swapRouter)
  usdc_addr=$(json "$DEP_JSON" usdc)
  c0=$(json "$DEP_JSON" poolKey.currency0)
  key="($c0,$(json "$DEP_JSON" poolKey.currency1),$(json "$DEP_JSON" poolKey.fee),$(json "$DEP_JSON" poolKey.tickSpacing),$hook)"
  read -r cap ask fee open <<<"$(cast call "$hook" "quote()(uint256,uint256,uint24,bool)" --rpc-url "$RPC" |
    awk '{print $1}' | paste -sd' ' -)"
  echo "hook quote: ask \$$(cast format-units "$ask" 6), fee $((fee / 100)) bps, market open $open, vault can sell $(cast format-units "$cap" 18) NVDAx now"
  [[ $(call "$(json "$DEP_JSON" vault)" "inventory()(uint256)") == 0 ]] && { echo "the vault holds no stock to sell" >&2; exit 1; }
  # buying NVDAx with USDC: zeroForOne when USDC is currency0
  if [[ $(tr '[:upper:]' '[:lower:]' <<<"$c0") == $(tr '[:upper:]' '[:lower:]' <<<"$usdc_addr") ]]; then
    nvdax_is0=false zfo=true
  else
    nvdax_is0=true zfo=false
  fi
  lim_push=$(sqrt_limit $((ask * 10005 / 10000)) $nvdax_is0) # just past the ask
  lim_fill=$(sqrt_limit $((ask * 10050 / 10000)) $nvdax_is0) # what the curve may charge for anything the hook can't fill
  send "$usdc_addr" "approve(address,uint256)" "$router" $((push + usdc))
  nonce=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
  # explicit gas: each is estimated against today's pool, before the other lands (a fill costs more than a curve swap)
  tx1=$(cast send --async --nonce "$nonce" --gas-limit 900000 "$router" \
    "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)" "$key" "($zfo,-$push,$lim_push)" \
    "(false,false)" 0x --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC")
  tx2=$(cast send --async --nonce $((nonce + 1)) --gas-limit 1500000 "$router" \
    "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)" "$key" "($zfo,-$usdc,$lim_fill)" \
    "(false,false)" 0x --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC")
  echo "push to the ask: $tx1 → $(cast receipt "$tx1" status --rpc-url "$RPC")"
  echo "buy:             $tx2 → $(cast receipt "$tx2" status --rpc-url "$RPC")"
  fill=$(cast receipt "$tx2" --json --rpc-url "$RPC" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const topic = process.argv[1].toLowerCase(), hook = process.argv[2].toLowerCase();
    const log = r.logs.find((l) => l.address.toLowerCase() === hook && l.topics[0].toLowerCase() === topic);
    if (!log) { console.log("none"); process.exit(0); }
    const w = log.data.slice(2).match(/.{64}/g).map((h) => BigInt("0x" + h));
    console.log(`${Number(w[0]) / 1e18} NVDAx for ${Number(w[1]) / 1e6} USDC at $${Number(w[2]) / 1e6}`);
  ' "$(cast keccak "InventoryFill(address,uint256,uint256,uint256,bool)")" "$hook")
  echo "hook fill from the vault: $fill (the keeper's syncHedge buys back the matching short next)"
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
  oracle=$(json "$DEP_JSON" markets.C_seiz3.oracle)
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
    exec pnpm --filter @seiz3/bots start
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
    "$(cast call "$(json "$DEP_JSON" markets.C_seiz3.oracle)" "price()(uint256)" --rpc-url "$RPC" |
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
  for name in A_naive B_conservative C_seiz3; do
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

# One run of the CRE market feed through the CLI's simulator. The workflow reads its config from
# packages/cre/market-feed/config.staging.json: market status from US market hours (marketStatus "marketHours") until
# the Data Streams key is authorized for the NVDA feed, then "dataStreams" with DATA_STREAM_USERNAME / HMAC_SECRET from
# .env.local. --broadcast sends the report through the simulation forwarder, paid by CRE_PRIVATE_KEY (falls back to
# the deployer, which the bots also send from).
cre_feed() {
  local cli
  cli=$(command -v cre || echo "$HOME/.cre/bin/cre")
  (cd "$ROOT/packages/cre" &&
    DATA_STREAMS_API_KEY=${DATA_STREAM_USERNAME:-} DATA_STREAMS_API_SECRET=${HMAC_SECRET:-} \
      CRE_ETH_PRIVATE_KEY=${CRE_PRIVATE_KEY:-$DEPLOYER_PRIVATE_KEY} \
      "$cli" workflow simulate market-feed --target staging-settings --non-interactive --trigger-index 0 "$@")
}

# What a DON would do: run the feed every CRE_INTERVAL_SEC (60) with --broadcast, forever. RiskParams treats a report
# older than maxReportAge (300 s) as stale and stops liquidations, so keep this running for the whole demo; a failed
# run is logged and the next one tries again. Stop it with Ctrl-C (then `cre-off` if nothing will report).
cre_loop() {
  local interval=${CRE_INTERVAL_SEC:-60} out line
  echo "CRE market feed every ${interval}s → RiskParams $(json "$DEP_JSON" riskParams)"
  # nothing in a run may end the loop: no -e here (a summary grep that matches nothing exits 1 under pipefail)
  set +e
  while true; do
    out=$(cre_feed --broadcast 2>&1)
    line=$(grep -E "Seiz3 market feed:|workflow execution failed" <<<"$out" | tail -1 | sed -E 's/^.*\] //')
    echo "$(date -u +%H:%M:%S) ${line:-no result: $(grep -v '^[[:space:]]*$' <<<"$out" | tail -1 | cut -c1-200)}"
    sleep "$interval"
  done
}

# RiskParams' view of the feed: the last report, its age, and what the vault and hook read from it
cre_status() {
  local rp open observed capacity now
  rp=$(json "$DEP_JSON" riskParams)
  read -r open observed capacity <<<"$(cast call "$rp" "lastReport()(bool,uint64,uint128)" --rpc-url "$RPC" |
    awk '{print $1}' | paste -sd' ' -)"
  now=$(cast block latest -f timestamp --rpc-url "$RPC")
  echo "RiskParams   $rp  maxReportAge=$(call "$rp" "maxReportAge()(uint32)")s"
  if [[ $observed == 0 ]]; then
    echo "CRE report   none yet: the owner's values apply"
  else
    echo "CRE report   open=$open  hedgeCapacity=\$$(cast format-units "$capacity" 6)  age=$((now - observed))s"
  fi
  echo "vault reads  marketOpen=$(call "$rp" "marketOpen()(bool)")  maxLiquidation=\$$(cast format-units "$(cast call "$rp" \
    "get()((uint256,uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint8,uint32,uint32,uint32,uint256,uint16,uint8))" \
    --rpc-url "$RPC" | tr -d '()' | cut -d, -f1 | awk '{print $1}')" 6)"
}

# cre-off: RiskParams ignores the feed and the owner's values apply again; cre-on [age]: back on (default 300 s)
cre_age() {
  send "$(json "$DEP_JSON" riskParams)" "setMaxReportAge(uint32)" "$1"
  cre_status
}

keeper() {
  : "${KEEPER_PRIVATE_KEY:?set KEEPER_PRIVATE_KEY in .env.local}"
  cd "$ROOT"
  # IDLE_RESERVE_USDC out of reach: a top-up goes through testnet's CoreDepositWallet, which loses it.
  # MORPHO_API_ENABLED=0: Morpho's API doesn't index our own Morpho copy. TICK_MS=2000 eases the public RPC's limits.
  # LOGS_RPC_URL: the borrower scan pages eth_getLogs past what Alchemy's free tier serves (10 blocks); as docker-compose
  RPC_URL=$RPC LOGS_RPC_URL=${LOGS_RPC_URL:-https://998.rpc.thirdweb.com} \
    KEEPER_PK=$KEEPER_PRIVATE_KEY DEPLOYMENTS_PATH=$DEP_JSON KILL_SWITCH_FILE=$ROOT/deployments/KILL \
    MORPHO_API_ENABLED=0 IDLE_RESERVE_USDC=1000000000 TICK_MS=${TICK_MS:-2000} \
    exec pnpm --filter @seiz3/keeper start
}

case "${1:-}" in
  big-blocks) big_blocks "${2:?usage: testnet-stack.sh big-blocks on|off}" ;;
  infra) infra ;;
  deploy) deploy ;;
  markets) markets ;;
  actors) actors ;;
  fund-core) fund_core "${2:-}" ;;
  sweep) sweep ;;
  crash) crash ;;
  cre) shift; cre_feed "$@" ;;
  borrow) borrow "${2:-}" ;;
  risk-set) shift; risk_set "$@" ;;
  faucet-cooldown) faucet_cooldown "${2:-}" ;;
  hook-fill) hook_fill "${2:-}" "${3:-}" ;;
  cre-loop) cre_loop ;;
  cre-status) cre_status ;;
  cre-off) cre_age 0 ;;
  cre-on) cre_age "${2:-300}" ;;
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
    echo "usage: scripts/testnet-stack.sh big-blocks on|off | infra | deploy | markets | actors | fund-core [usdc] | sweep | status |" \
      "keeper | borrow <nvdax> | hook-fill <usdc> | risk-set <field> <value>… | faucet-cooldown <sec> | crash | cre [--broadcast] | cre-loop | cre-status | cre-off | cre-on [age] | extras | seed deep|thin <usdc> | fund-vault <usdc> |" \
      "fund-faucet <nvdax> <usdc> <hype> | fund-naive <usdc> | bots | release | reclaim" >&2
    exit 1
    ;;
esac
