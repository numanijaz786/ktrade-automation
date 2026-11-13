# Deployment Guide

> **Status:** local development deployment works today. A production deployment (single secure URL) is **not done yet**. It needs hosting approval (USER_ACTION_REQUIRED #5) and the Phase 12 hardening items listed in SECURITY_REPORT.md.

## Local (development)

Prerequisites: Node 24 LTS, Docker, `corepack enable pnpm`.

```bash
pnpm install
pnpm db:up                                     # Postgres 16 + Valkey 8 on 127.0.0.1
cp .env.example apps/api/.env
pnpm --filter @ktrade/api keys:generate        # paste output into apps/api/.env (never commit)
cd apps/api
pnpm exec prisma generate
pnpm db:deploy                                 # migrations
cd ../.. && pnpm build
pnpm --filter @ktrade/api db:seed              # stocks + SIMULATED prices + KTrade fee schedule
pnpm --filter @ktrade/api start                # http://127.0.0.1:3001  (Swagger /api/docs)
pnpm --filter @ktrade/web dev                  # http://localhost:3000  (demo data client for now)
```

Then register the single owner account (`POST /api/v1/auth/register`). Registration closes after the first account.

## Production (planned, Phase 12)

- `docker compose` with: postgres, valkey, a one-shot `migrate`, api, worker, web and nginx (TLS via Let's Encrypt).
- Secrets from a secret manager or OS keychain, never in images or git.
- Nightly encrypted `pg_dump` with a monthly restore test.
- Access restricted to the owner (authentication, plus an optional IP allow-list or VPN).
- A pre-go-live checklist, to be verified and recorded here: auth and authorization tests, HTTPS-only + HSTS, secrets audit, backups restored, critical test suites green.

## Cost estimate (to be confirmed with you before any purchase)

| Item                | Monthly                                |
| ------------------- | -------------------------------------- |
| VPS (2 vCPU / 4 GB) | ~US$6–12                               |
| Domain              | ~US$1 (≈ US$10–15/year)                |
| TLS (Let's Encrypt) | free                                   |
| Market-data vendor  | vendor quote (USER_ACTION_REQUIRED #3) |
| LLM API (optional)  | usage-based                            |
