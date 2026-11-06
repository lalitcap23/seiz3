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
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --filter @afterbell/keeper...

COPY packages/keeper ./packages/keeper
COPY packages/shared/src ./packages/shared/src

RUN pnpm --filter @afterbell/keeper typecheck \
  && pnpm --filter @afterbell/keeper build

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "@afterbell/keeper", "start"]
