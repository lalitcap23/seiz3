#!/usr/bin/env bash
# Ship this working tree to the VPS (seiz3.xyz): copy the code, build the images there, swap the containers.
#
#   pnpm vps:deploy          # or scripts/vps-deploy.sh
#
# The old version keeps serving while the images build (a few minutes); the swap itself takes seconds.
# Builds run on the VPS: it's x86_64 and this Mac is arm64. One image at a time, to stay inside its 4 GB.
#
# What goes up: the code, .env.local (the keys) and the deployment address files. What stays on the VPS:
#   deployments/  the stack's runtime state (watch files, feed cache, bot hold, logs): only the address files are replaced
#   cloudflared/  the tunnel's credentials + config (exists only there)
#   ~/.cre        the CRE CLI login, which rotates its token in place there
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEY=${VPS_KEY:-$ROOT/guest_ed25519}
HOST=${VPS_HOST:-guest@159.195.200.178}
DIR=afterbell # on the VPS, under ~ (kept from before the rename: cloudflared/ and the state live there)
ADDRESS_FILES=(base-sepolia.json base-sepolia-infra.json)

echo "== copying code to $HOST:~/$DIR"
# --delete removes files deleted here, but never touches excluded paths on the VPS (deployments/, cloudflared/)
rsync -az --delete -e "ssh -i $KEY" \
  --exclude node_modules --exclude .git --exclude /contracts --exclude .next --exclude dist --exclude '*.tsbuildinfo' \
  --exclude 'packages/*/.env*' --exclude /guest_ed25519 --exclude /FOR_GUEST.txt \
  --exclude /analysis --exclude /docs --exclude /mocks \
  --exclude /deployments --exclude /cloudflared \
  "$ROOT/" "$HOST:$DIR/"
(cd "$ROOT/deployments" && rsync -az -e "ssh -i $KEY" "${ADDRESS_FILES[@]}" "$HOST:$DIR/deployments/")

ssh -i "$KEY" "$HOST" "DIR=$DIR ADDRESS_FILES='${ADDRESS_FILES[*]}' bash -s" <<'REMOTE'
set -euo pipefail
cd ~/"$DIR"
# rootless docker: the containers' `node` user sees host files as root-owned, so they must be world-writable
(cd deployments && chmod a+rw $ADDRESS_FILES)
C="docker compose -f docker-compose.base.yml -f docker-compose.vps.yml"

# risk-engine's image is the one relayer/keeper/bots/api share; cre and web have their own
for s in risk-engine cre web; do
  echo "== building $s"
  $C build "$s" 2>&1 | tail -20
done

# One-time, after the afterbell → seiz3 rename: the stack started before it runs as project afterbell-base. Stop it
# before the new one starts, or two relayers place every order twice. A no-op once it's gone.
if [ -n "$(docker ps -q --filter label=com.docker.compose.project=afterbell-base)" ]; then
  echo "== stopping the pre-rename stack (afterbell-base)"
  docker compose -p afterbell-base -f docker-compose.base.yml -f docker-compose.vps.yml down --remove-orphans
  docker image rm afterbell-base-services afterbell-base-cre afterbell-web:base >/dev/null 2>&1 || true
fi

echo "== restarting changed containers"
$C up -d --no-build --remove-orphans
docker image prune -f >/dev/null # the previous version's now-untagged images (20 GB disk, images count)
$C ps --format '{{.Service}}\t{{.Status}}'
REMOTE

echo "== checking through Cloudflare"
for u in https://seiz3.xyz/ https://api.seiz3.xyz/health; do
  curl -fsS -m 20 --retry 12 --retry-delay 5 --retry-all-errors -o /dev/null -w "$u -> %{http_code}\n" "$u" \
    || echo "$u -> FAILED (logs: pnpm vps:logs)"
done
