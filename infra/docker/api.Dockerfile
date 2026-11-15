# KTrade API (NestJS 12, ESM, Prisma 7) — production image. Build from the REPO ROOT:
#   docker build -f infra/docker/api.Dockerfile --target runtime -t ktrade-api .
#   docker build -f infra/docker/api.Dockerfile --target migrate -t ktrade-migrate .
# Targets:
#   runtime  (default) node dist/main.js           — seed: `node dist/seed/seed.js`
#   migrate  prisma migrate deploy (one-shot)       — the only image that carries the Prisma CLI
# No secrets are baked in: everything comes from the environment at run time (infra/.env.prod).

ARG NODE_IMAGE=node:24-bookworm-slim

# ─── base: Node 24 + pnpm (version pinned by package.json "packageManager") ───
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ─── build: install (lockfile-exact), generate Prisma client, compile api + workspace deps ───
FROM base AS build
# openssl: Prisma engine platform detection.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/finance-core/package.json packages/finance-core/
COPY packages/broker-sdk/package.json packages/broker-sdk/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ktrade/api..." --filter "ktrade-smart-trading"
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @ktrade/api exec prisma generate \
 && pnpm exec turbo run build --filter=@ktrade/api...
# Pruned production tree (workspace packages copied with their "files": dist) …
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ktrade/api deploy --prod --legacy /out/runtime \
 && rm -rf /out/runtime/src /out/runtime/test /out/runtime/dist \
 && cp -r apps/api/dist /out/runtime/dist \
 && cp -r apps/api/prisma /out/runtime/prisma \
 && cp apps/api/prisma.config.ts /out/runtime/
# … and a migrate-only tree that keeps the Prisma CLI (a devDependency).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ktrade/api deploy --legacy /out/migrate \
 && rm -rf /out/migrate/src /out/migrate/test /out/migrate/dist \
 && cp -r apps/api/prisma /out/migrate/prisma \
 && cp apps/api/prisma.config.ts /out/migrate/

# ─── migrate: `prisma migrate deploy` against DATABASE_URL, then exit ───
FROM ${NODE_IMAGE} AS migrate
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out/migrate/ ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ─── runtime (default): the API ───
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
# Owned by root, read-only for the unprivileged `node` user that runs the process.
COPY --from=build --chown=root:root /out/runtime/ ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
