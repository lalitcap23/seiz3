# Every off-chain service but the web: keeper, risk-engine stub, API (+ replay it spawns) and bots.
# deployments/ is mounted at runtime (docker-compose.testnet.yml: `pnpm testnet:up`), not baked in: replay setup rewrites it.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.17.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/keeper/package.json packages/keeper/
COPY packages/api/package.json packages/api/
COPY packages/replay/package.json packages/replay/
COPY packages/bots/package.json packages/bots/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile \
  --filter @afterbell/keeper... --filter @afterbell/api... --filter @afterbell/replay... --filter @afterbell/bots...

COPY packages/keeper ./packages/keeper
COPY packages/api ./packages/api
COPY packages/replay ./packages/replay
COPY packages/bots ./packages/bots
COPY packages/shared ./packages/shared
# shared imports the deployment files at type level; the real ones come from the volume
COPY deployments/testnet.json deployments/mainnet.json ./deployments/

RUN chown -R node:node /app/deployments
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
