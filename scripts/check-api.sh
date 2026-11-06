#!/usr/bin/env bash
# Step 4's check: every value the API's /snapshot reports, against `cast call` at the snapshot's own block.
#
#   NETWORK=local pnpm api                                   # the collector, against scripts/local-stack.sh
#   scripts/check-api.sh deployments/local.json              # default rpc http://127.0.0.1:8545, api http://localhost:8787
#   scripts/check-api.sh deployments/testnet.json https://rpc.hyperliquid-testnet.xyz/evm
set -euo pipefail
DEP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
RPC=${2:-http://127.0.0.1:8545}
API=${3:-http://localhost:8787}
SNAP=$(curl -s "$API/snapshot")
j() { node -e 'const o=JSON.parse(process.argv[1]); console.log(process.argv[2].split(".").reduce((a,k)=>a[k],o))' "$SNAP" "$1"; }
d() { node -e 'const o=require(process.argv[1]); console.log(process.argv[2].split(".").reduce((a,k)=>a[k],o))' "$DEP" "$1"; }
B=$(j blockNumber)
c() { cast call "$@" --block "$B" --rpc-url "$RPC" | awk '{print $1}'; }
pass=0; fail=0
eq() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); printf '  ✓ %-34s %s\n' "$1" "$2"; else fail=$((fail+1)); printf '  ✗ %-34s api=%s cast=%s\n' "$1" "$2" "$3"; fi; }

V=$(d vault); M=$(d morpho)
echo "block $B, vault $V"
echo "vault"
eq inventory "$(j vault.inventory)" "$(c $V 'inventory()(uint256)')"
eq confirmedShort "$(j vault.confirmedShort)" "$(c $V 'confirmedShort()(int64)')"
eq pendingHedge.delta "$(j vault.pendingHedge.delta)" "$(cast call $V 'pendingHedge()(int64,uint64,uint64,uint8)' --block $B --rpc-url $RPC | head -1 | awk '{print $1}')"
eq hedgeState "$(j vault.hedgeState)" "$(echo Idle Pending Retrying Paused | cut -d' ' -f$(( $(c $V 'hedgeState()(uint8)') + 1 )))"
eq paused "$(j vault.paused)" "$(c $V 'paused()(bool)')"
eq totalAssets "$(j vault.totalAssets)" "$(c $V 'totalAssets()(uint256)')"
eq totalSupply "$(j vault.totalSupply)" "$(c $V 'totalSupply()(uint256)')"
eq marginFloat "$(j vault.marginFloat)" "$(c $V 'marginFloat()(uint256)')"
eq marketOpen "$(j marketOpen)" "$(c $(d riskParams) 'marketOpen()(bool)')"

for i in 0 1 2; do
  N=$(j markets.$i.name); ID=$(d markets.$N.id); OR=$(d markets.$N.oracle)
  echo "market $N"
  MK=$(cast call $M 'market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)' $ID --block $B --rpc-url $RPC | awk '{print $1}' | tr '\n' ' ')
  eq totalBorrow "$(j markets.$i.totalBorrow)" "$(echo $MK | cut -d' ' -f3)"
  eq oraclePrice "$(j markets.$i.oraclePrice)" "$(node -e "console.log(Number(BigInt('$(c $OR 'price()(uint256)')')/10n**18n)/1e6)")"
  BW=$(j markets.$i.borrower.address)
  if [[ $BW != 0x0000000000000000000000000000000000000000 ]]; then
    P=$(cast call $M 'position(bytes32,address)(uint256,uint128,uint128)' $ID $BW --block $B --rpc-url $RPC | awk '{print $1}' | tr '\n' ' ')
    eq borrower.collateral "$(j markets.$i.borrower.collateral)" "$(echo $P | cut -d' ' -f3)"
    TBA=$(echo $MK | cut -d' ' -f3); TBS=$(echo $MK | cut -d' ' -f4); BS=$(echo $P | cut -d' ' -f2)
    eq borrower.debt "$(j markets.$i.borrower.debt)" "$(node -e "const s=${BS}n,a=${TBA}n,t=${TBS}n; console.log(s===0n?'0':((s*(a+1n)+t+1000000n-1n)/(t+1000000n)).toString())")"
  else
    echo "  - no borrower configured"
  fi
done

echo "hyperliquid (precompiles)"
PI=$(( $(d hypercore.perpAsset) - 100000 )); DX=$(d hypercore.perpDexIndex); SZ=$(d hypercore.szDecimals)
SZI=$(cast abi-decode 'f()(int64,uint64,int64,uint32,bool)' $(cast call 0x0000000000000000000000000000000000000813 $(cast abi-encode 'f(address,uint32)' $V $PI) --block $B --rpc-url $RPC) | head -1 | awk '{print $1}')
eq size "$(j hyperliquid.size)" "$(node -e "console.log($SZI/10**$SZ)")"
AV=$(cast abi-decode 'f()(int64,uint64,uint64,int64)' $(cast call 0x000000000000000000000000000000000000080F $(cast abi-encode 'f(uint32,address)' $DX $V) --block $B --rpc-url $RPC) | head -1 | awk '{print $1}')
eq accountValue "$(j hyperliquid.accountValue)" "$(node -e "console.log($AV/1e6)")"
OP=$(cast abi-decode 'f()(uint64)' $(cast call 0x0000000000000000000000000000000000000807 $(cast abi-encode 'f(uint32)' $PI) --block $B --rpc-url $RPC) | awk '{print $1}')
eq oraclePx "$(j hyperliquid.oraclePx)" "$(node -e "console.log($OP/10**(6-$SZ))")"

echo "pool"
SQ=$(cast call $(d poolManager) 'extsload(bytes32)(bytes32)' $(cast keccak $(cast concat-hex $(cast keccak $(cast abi-encode 'f(address,address,uint24,int24,address)' $(d poolKey.currency0) $(d poolKey.currency1) $(d poolKey.fee) $(d poolKey.tickSpacing) $(d poolKey.hooks))) 0x0000000000000000000000000000000000000000000000000000000000000006)) --block $B --rpc-url $RPC)
eq sqrtPriceX96 "$(j pool.sqrtPriceX96)" "$(node -e "console.log((BigInt('$SQ') & ((1n<<160n)-1n)).toString())")"
echo "  pool.price (USDC per NVDAx) = $(j pool.price)"

echo "activity: $(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.activity.length, "events:", s.activity.map(a=>a.type).join(", ") || "none")' "$SNAP")"
echo "badDebt: $(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.markets.map(m=>m.name+"="+m.badDebt).join(" "))' "$SNAP")"
echo "hedgeRatio $(j vault.hedgeRatio), sharePrice $(j vault.sharePrice)"
echo "RESULT: $pass match, $fail differ"
