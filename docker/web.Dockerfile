# The dashboard (/) and tester page (/try). NEXT_PUBLIC_* are baked in at build time: the browser, not this
# container, calls the API and the RPC, so NEXT_PUBLIC_API_URL is the API as the browser sees it.
FROM node:22-slim

RUN npm install -g pnpm@11.17.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/keeper/package.json packages/keeper/
COPY packages/api/package.json packages/api/
COPY packages/replay/package.json packages/replay/
COPY packages/bots/package.json packages/bots/
COPY packages/risk-engine/package.json packages/risk-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --filter @afterbell/web...

COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
# shared bundles the deployment addresses into the page
COPY deployments/testnet.json deployments/mainnet.json ./deployments/

ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ARG NEXT_PUBLIC_NETWORK=testnet
ARG NEXT_PUBLIC_RPC_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_NETWORK=$NEXT_PUBLIC_NETWORK \
    NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
    NEXT_PUBLIC_USE_FIXTURE=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @afterbell/web build

USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@afterbell/web", "start", "--port", "3000"]
