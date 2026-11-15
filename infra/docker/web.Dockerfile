# KTrade web (Next.js 16 + BFF) — production image using Next's standalone output. Build from the REPO ROOT:
#   docker build -f infra/docker/web.Dockerfile -t ktrade-web .
# NEXT_PUBLIC_DATA_MODE is inlined into the client bundle at BUILD time, so it is a build arg (default api).
# API_BASE_URL and BFF_COOKIE_SECURE are read at RUN time by the BFF route handlers.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_DATA_MODE=api
ENV NEXT_PUBLIC_DATA_MODE=${NEXT_PUBLIC_DATA_MODE} \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/finance-core/package.json packages/finance-core/
COPY packages/broker-sdk/package.json packages/broker-sdk/
# NODE_ENV=production would skip devDependencies (tailwind, typescript) that `next build` needs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile --filter "@ktrade/web..." --filter "ktrade-smart-trading"
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
# next/font/google downloads the Geist fonts here (build-time network only; self-hosted at runtime).
# Loose env mode: turbo 2's strict mode would hide NEXT_OUTPUT / NEXT_PUBLIC_DATA_MODE from `next build`.
RUN pnpm exec turbo run build --filter=@ktrade/web... --env-mode=loose \
 && test -f apps/web/.next/standalone/apps/web/server.js

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Standalone keeps the monorepo layout: server.js lives at apps/web/server.js.
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=root:root /repo/apps/web/public ./apps/web/public
# Next writes its ISR / image cache under .next/cache at run time: the only writable path.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
