#!/usr/bin/env bash
# Spikes 2a–2d on Hyperliquid testnet, from a plain EOA: no vault, Morpho or v4 needed.
#
# Makes the same HyperCore calls the vault makes (CoreDepositWallet deposits, CoreWriter actions, read precompiles)
# and times how long each takes to show up in the precompiles. It needs testnet HYPE for gas and USDC on HyperEVM.
#
# Spike 2a/2b result: testnet's CoreDepositWallet takes the USDC and never credits HyperCore, for new and existing
# accounts alike, so the deposit commands refuse on testnet (they're kept for mainnet). Fund a testnet account by
# sending it USDC on HyperCore (Hyperliquid app → Send), then `sweep` it to the perp dex.
#
#   export SPIKE_PK=0x…                      # testnet key, funded on HyperEVM
#   scripts/spike-core.sh status             # EVM balances, Core account, xyz margin, position (precompiles + API)
#   scripts/spike-core.sh sweep 1            # 2a: first CoreWriter action, spot → xyz (the vault's sweepSpotToDex)
#   scripts/spike-core.sh deposit-dex 2      # 2b: CoreDepositWallet straight to xyz (the vault's default top-up)
#   scripts/spike-core.sh deposit-spot 2     # 2b fallback: CoreDepositWallet to spot, then sweep
#   scripts/spike-core.sh book               # 2c: are there bids to short into?
#   scripts/spike-core.sh short 0.05         # 2c + 2d: IOC sell, then blocks/seconds until position2 shows it
#   scripts/spike-core.sh close 0.05         # IOC buy, reduce-only
#
# COIN (default xyz:NVDA) is resolved through the info API, so the dex index is right on either network
# (xyz is dex 65 on testnet, 1 on mainnet). Orders are min $10 notional; testnet books are thin.
set -euo pipefail

RPC=${RPC_URL:-https://rpc.hyperliquid-testnet.xyz/evm}
API=${HL_INFO_API_URL:-https://api.hyperliquid-testnet.xyz/info}
USDC=${USDC_ADDRESS:-0x2B3370eE501B4a559b57D449569354196457D8Ab}
CDW=${CORE_DEPOSIT_WALLET:-0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206}
COIN=${COIN:-xyz:NVDA}
DEX_NAME=${COIN%%:*}

CORE_WRITER=0x3333333333333333333333333333333333333333
P_SPOT_BALANCE=0x0000000000000000000000000000000000000801
P_ORACLE_PX=0x0000000000000000000000000000000000000807
P_MARGIN_SUMMARY=0x000000000000000000000000000000000000080F
P_USER_EXISTS=0x0000000000000000000000000000000000000810
P_POSITION2=0x0000000000000000000000000000000000000813
SPOT_DEX=4294967295 # type(uint32).max
IOC=3

# info <json>: POST to the Hyperliquid info API
info() {
  curl -s -m 15 "$API" -H 'Content-Type: application/json' -d "$1"
}

# market: "<dexIndex> <indexInMeta> <szDecimals>" for COIN
market() {
  node -e '
    const [api, coin] = process.argv.slice(1);
    const post = (body) =>
      fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => r.json());
    (async () => {
      const name = coin.split(":")[0];
      const dex = (await post({ type: "perpDexs" })).findIndex((d) => d && d.name === name);
      const meta = dex < 0 ? { universe: [] } : await post({ type: "meta", dex: name });
      const idx = meta.universe.findIndex((u) => u.name === coin);
      if (idx < 0) throw new Error(`${coin} is not listed on ${api}`);
      console.log(dex, idx, meta.universe[idx].szDecimals);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$API" "$COIN"
}

# precompile <address> <arg types> <return types> <args…>: first return value
precompile() {
  local addr=$1 in=$2 out=$3
  shift 3
  cast abi-decode "f()($out)" "$(cast call "$addr" "$(cast abi-encode "f($in)" "$@")" --rpc-url "$RPC")" |
    head -1 | awk '{print $1}'
}

user_exists() { precompile $P_USER_EXISTS "address" "bool" "$ME"; }
spot_usdc() { precompile $P_SPOT_BALANCE "address,uint64" "uint64,uint64,uint64" "$ME" 0; } # 8 decimals
dex_value() { precompile $P_MARGIN_SUMMARY "uint32,address" "int64,uint64,uint64,int64" "$DEX" "$ME"; } # 6 dec
szi() { precompile $P_POSITION2 "address,uint32" "int64,uint64,int64,uint32,bool" "$ME" "$PERP"; } # szDecimals
oracle_px() { precompile $P_ORACLE_PX "uint32" "uint64" "$PERP"; } # 6 - szDecimals decimals

# fmt <integer> <decimals>
fmt() {
  awk -v v="$1" -v d="$2" 'BEGIN { printf "%.*f", d, v / 10 ^ d }'
}

# send <to> <sig> <args…>: broadcast, fail on revert, print the receipt's block number
send() {
  cast send "$@" --private-key "$SPIKE_PK" --rpc-url "$RPC" --json |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const r = JSON.parse(s);
        if (r.status !== "0x1") { console.error("reverted:", r.transactionHash); process.exit(1); }
        console.log(parseInt(r.blockNumber, 16));
      });
    '
}

# action <id> <arg types> <args…>: CoreWriter wire format, version byte 1 + 3-byte action id + ABI-encoded args
action() {
  local id=$1 types=$2 args
  shift 2
  args=$(cast abi-encode "f($types)" "$@")
  printf '0x01%06x%s' "$id" "${args#0x}"
}

# until_changed <fn> <before> <tx block>: poll fn until it differs from <before>, report blocks and seconds taken
until_changed() {
  local fn=$1 before=$2 blk=$3 start val
  start=$(date +%s)
  for _ in $(seq 1 120); do
    val=$($fn 2>/dev/null || echo "$before")
    if [[ $val != "$before" ]]; then
      echo "  $fn: $before → $val after $(($(cast block-number --rpc-url "$RPC") - blk)) blocks, $(($(date +%s) - start)) s"
      return 0
    fi
    sleep 0.5
  done
  echo "  $fn still $before after 60 s: dropped or not landed yet. Run status and check the API side." >&2
  return 1
}

status() {
  local evm_usdc
  evm_usdc=$(cast call "$USDC" "balanceOf(address)(uint256)" "$ME" --rpc-url "$RPC" | awk '{print $1}')
  echo "account    $ME"
  echo "market     $COIN: dex $DEX, order asset $ASSET, read index $PERP, szDecimals $SZD"
  echo "EVM        $(cast balance --ether "$ME" --rpc-url "$RPC") HYPE, $(fmt "$evm_usdc" 6) USDC"
  echo "precompile exists=$(user_exists)  spot USDC=$(fmt "$(spot_usdc 2>/dev/null || echo 0)" 8)" \
    " $DEX_NAME value=$(fmt "$(dex_value 2>/dev/null || echo 0)" 6)  szi=$(fmt "$(szi 2>/dev/null || echo 0)" "$SZD")" \
    " oracle=$(fmt "$(oracle_px)" $((6 - SZD)))"
  info "{\"type\":\"clearinghouseState\",\"user\":\"$ME\",\"dex\":\"$DEX_NAME\"}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const p = (j.assetPositions || []).find((a) => a.position.coin === process.argv[1]);
      console.log(`API        ${process.argv[2]} value=${j.marginSummary.accountValue}  szi=${p ? p.position.szi : 0}`);
    });
  ' "$COIN" "$DEX_NAME"
  info "{\"type\":\"spotClearinghouseState\",\"user\":\"$ME\"}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const b = (JSON.parse(s).balances || []).find((x) => x.coin === "USDC");
      console.log(`API        spot USDC=${b ? b.total : 0}`);
    });
  '
}

# Spike 2a/2b: testnet's CoreDepositWallet never credits HyperCore, so a deposit there is lost
require_mainnet() {
  if [[ $(cast chain-id --rpc-url "$RPC") == 998 ]]; then
    echo "testnet's CoreDepositWallet never credits HyperCore: this deposit would be lost. Send USDC on HyperCore." >&2
    exit 1
  fi
}

# 2b fallback: CoreDepositWallet to Core spot (then `sweep` to the perp dex)
deposit_spot() {
  local amt before blk
  require_mainnet
  amt=$(cast parse-units "${1:-2}" 6)
  before=$(spot_usdc)
  send "$USDC" "approve(address,uint256)" "$CDW" "$amt" >/dev/null
  blk=$(send "$CDW" "deposit(uint256,uint32)" "$amt" "$SPOT_DEX")
  echo "deposited ${1:-2} USDC to Core spot in block $blk"
  until_changed spot_usdc "$before" "$blk"
}

# 2a / 2b fallback: sendAsset spot → perp dex, the vault's sweepSpotToDex and SPOT_DEX top-up path
sweep() {
  local before blk
  before=$(dex_value)
  blk=$(send "$CORE_WRITER" "sendRawAction(bytes)" \
    "$(action 13 "address,address,uint32,uint32,uint64,uint64" "$ME" 0x0000000000000000000000000000000000000000 \
      "$SPOT_DEX" "$DEX" 0 "$(cast parse-units "${1:-2}" 8)")")
  echo "sendAsset ${1:-2} USDC spot → $DEX_NAME in block $blk"
  until_changed dex_value "$before" "$blk"
}

# 2b: does CoreDepositWallet with the dex index credit the perp dex directly?
deposit_dex() {
  local amt before blk
  require_mainnet
  amt=$(cast parse-units "${1:-2}" 6)
  before=$(dex_value)
  send "$USDC" "approve(address,uint256)" "$CDW" "$amt" >/dev/null
  blk=$(send "$CDW" "deposit(uint256,uint32)" "$amt" "$DEX")
  echo "deposited ${1:-2} USDC with destinationDex=$DEX in block $blk"
  until_changed dex_value "$before" "$blk" ||
    echo "  → not credited to $DEX_NAME. If spot grew, use deposit-spot + sweep, i.e. setMarginDepositDex($SPOT_DEX)."
}

book() {
  info "{\"type\":\"l2Book\",\"coin\":\"$COIN\"}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [bids, asks] = JSON.parse(s).levels;
      const row = (l) => `${l.px.padStart(10)} × ${l.sz}`;
      console.log("asks\n" + asks.slice(0, 5).reverse().map(row).join("\n"));
      console.log("bids\n" + bids.slice(0, 5).map(row).join("\n"));
    });
  '
}

# order <isBuy> <size> <limit usd> <reduceOnly>: IOC through CoreWriter, then time the precompile
order() {
  local is_buy=$1 size=$2 limit=$3 reduce=$4 before blk since
  before=$(szi 2>/dev/null || echo 0)
  since=$((($(date +%s) - 5) * 1000))
  blk=$(send "$CORE_WRITER" "sendRawAction(bytes)" \
    "$(action 1 "uint32,bool,uint64,uint64,bool,uint8,uint128" "$ASSET" "$is_buy" \
      "$(cast parse-units "$limit" 8)" "$(cast parse-units "$size" 8)" "$reduce" "$IOC" 0)")
  echo "IOC $([[ $is_buy == true ]] && echo buy || echo sell) $size $COIN, limit \$$limit, asset $ASSET, in block $blk"
  until_changed szi "$before" "$blk" || true
  # CoreWriter never reverts; the info API says what became of the order (filled, oracleRejected, iocCancelRejected…)
  info "{\"type\":\"historicalOrders\",\"user\":\"$ME\"}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const o = JSON.parse(s).find((x) => x.order.coin === process.argv[1] && x.statusTimestamp >= +process.argv[2]);
      console.log(o ? `  order status: ${o.status}` : "  order not in the API: dropped before it reached the book");
    });
  ' "$COIN" "$since"
  info "{\"type\":\"userFillsByTime\",\"user\":\"$ME\",\"startTime\":$since}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const f = JSON.parse(s).filter((x) => x.coin === process.argv[1]);
      console.log(f.length ? f.map((x) => `  fill ${x.side} ${x.sz} @ ${x.px}`).join("\n") : "  no fills");
    });
  ' "$COIN"
}

# default limit: oracle ± 10%, whole dollars (always a valid tick); pass one explicitly if the book is off-oracle
limit_px() {
  awk -v raw="$(oracle_px)" -v d=$((6 - SZD)) -v f="$1" 'BEGIN { printf "%d", raw / 10 ^ d * f }'
}

case "${1:-}" in
  book) book ;;
  status | sweep | deposit-dex | deposit-spot | short | close)
    : "${SPIKE_PK:?export SPIKE_PK (a testnet key)}"
    ME=$(cast wallet address "$SPIKE_PK")
    MARKET=$(market)
    read -r DEX IDX SZD <<<"$MARKET"
    PERP=$((DEX * 10000 + IDX))
    ASSET=$((100000 + PERP))
    case $1 in
      status) status ;;
      sweep) sweep "${2:-}" ;;
      deposit-dex) deposit_dex "${2:-}" ;;
      deposit-spot) deposit_spot "${2:-}" ;;
      short) order false "${2:-0.05}" "${3:-$(limit_px 0.9)}" false ;;
      close) order true "${2:-0.05}" "${3:-$(limit_px 1.1)}" true ;;
    esac
    ;;
  *)
    echo "usage: scripts/spike-core.sh status | sweep [usdc] | deposit-dex [usdc] | deposit-spot [usdc] | book |" \
      "short [size] [limitUsd] | close [size] [limitUsd]" >&2
    exit 1
    ;;
esac
