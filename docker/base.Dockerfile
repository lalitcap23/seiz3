# Afterbell on Base Sepolia (docker-compose.base.yml): every service `scripts/base-stack.sh sepolia live` runs on the
# host, each through that same script, so the env each one gets is written down in one place.
#   services  risk-engine stub, relayer, keeper, bots, API
#   cre       + Bun and the Chainlink CRE CLI: the CRE loop (`cre workflow simulate base-feed --broadcast`)
# deployments/ is mounted at runtime, not baked in: the keeper, bots and API write to it (watch file, feed cache).
FROM node:22-slim AS services

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.17.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/keeper/package.json packages/keeper/
COPY packages/api/package.json packages/api/
COPY packages/replay/package.json packages/replay/
COPY packages/bots/package.json packages/bots/
COPY packages/relayer/package.json packages/relayer/
COPY packages/cre/package.json packages/cre/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile \
  --filter @afterbell/keeper... --filter @afterbell/api... --filter @afterbell/replay... \
  --filter @afterbell/bots... --filter @afterbell/relayer... --filter @afterbell/cre...

COPY packages/keeper ./packages/keeper
COPY packages/api ./packages/api
COPY packages/replay ./packages/replay
COPY packages/bots ./packages/bots
COPY packages/relayer ./packages/relayer
COPY packages/cre ./packages/cre
COPY packages/shared ./packages/shared
COPY scripts/base-stack.sh ./scripts/
# shared imports the deployment files at type level; the real ones come from the volume
COPY deployments/testnet.json deployments/mainnet.json ./deployments/

# the CRE loop writes the workflow's config and build output next to it
RUN chown -R node:node /app/deployments /app/packages/cre
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]

FROM services AS cre

USER root
# Bun runs the TypeScript SDK's cre-compile; the CLI is Chainlink's Linux build for this image's arch. Its default
# build needs glibc 2.38 and bookworm has 2.36, so the _ldd2-35 one (Chainlink's build for older glibc)
ARG TARGETARCH
ARG CRE_VERSION=v1.39.0
ARG BUN_VERSION=1.4.2
RUN npm install -g bun@${BUN_VERSION} \
  && curl -fsSL "https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/cre_linux_${TARGETARCH}_ldd2-35.tar.gz" \
    | tar -xz -C /tmp \
  && mv "/tmp/cre_${CRE_VERSION}_linux_${TARGETARCH}" /usr/local/bin/cre \
  && chmod +x /usr/local/bin/cre \
  && cre version

USER node
# javy (the JS → wasm compiler cre-compile drives) is fetched on first use: one compile of the workflow fetches it into
# the image, and fails the build here rather than in the loop if the toolchain is broken
RUN cd packages/cre && ./node_modules/.bin/cre-compile base-feed/main.ts /tmp/base-feed.wasm && rm /tmp/base-feed.wasm
