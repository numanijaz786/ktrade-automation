# ktrade-automation

A personal smart-trading and portfolio platform for one **KTrade (PSX)** brokerage account. It covers portfolio tracking, decimal-exact accounting, strategy signals, backtesting, paper trading and a safety-first order workflow.

> **Status:** in active development. See [`DEVELOPMENT_STATUS.md`](DEVELOPMENT_STATUS.md) and [`TODO.md`](TODO.md).

## Safety model (read this first)

- **No unauthorized broker automation.** KTrade publishes no API and has not authorized browser automation ([docs/01](docs/01-ktrade-feasibility-report.md), [docs/03](docs/03-browser-automation-investigation.md)). Both KTrade adapters are disabled stubs behind a capability chain: implemented ∧ verified ∧ authorized ∧ enabled.
- **Live orders are manual.** The app prepares and risk-checks an order, you approve it with a second factor, then **you place it yourself in the KTrade app**. The global kill switch is **OFF** by default.
- **No credentials stored.** KTrade/PSX passwords, PINs and OTPs are never stored. Other secrets are envelope-encrypted.
- **Every number has provenance:** confirmed, broker-displayed, market data, manual, estimated or simulated.
- **No floating-point money.** Decimal arithmetic everywhere; PostgreSQL `NUMERIC` in the database.

## Stack

| Layer   | Tech                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| API     | NestJS 12 (ESM), Prisma 7, PostgreSQL 16, Valkey 8 (Redis-compatible), BullMQ, Zod                         |
| Web     | Next.js 16, React 19, Tailwind 4, shadcn/ui (Radix), TanStack Query/Table, lightweight-charts, Recharts    |
| Domain  | `packages/finance-core`: fees, WAC/FIFO ledger, returns, indicators, strategy DSL, risk engine, backtester |
| Tooling | pnpm 10 + Turborepo, TypeScript 6, ESLint 10, Vitest 4, Testcontainers                                     |

## Repository layout

```
apps/api            NestJS API (auth, ledger, portfolio, trading, imports, market data)
apps/web            Next.js dashboard
packages/finance-core   pure, decimal-exact financial logic
packages/shared         enums + Zod schemas shared by api and web
packages/broker-sdk     broker / market-data adapter interfaces + capability model
infra/              docker-compose (Postgres + Valkey, bound to 127.0.0.1)
docs/               design specs 01–09
```

## Getting started

Prerequisites: Node 24 LTS, Docker, corepack (`corepack enable pnpm`).

```bash
pnpm install
pnpm db:up                                   # Postgres 16 + Valkey 8 on localhost

cp .env.example apps/api/.env
pnpm --filter @ktrade/api keys:generate      # prints JWT keys + master key → paste into apps/api/.env (never commit)

cd apps/api
pnpm exec prisma generate
pnpm db:deploy                               # apply migrations
cd ../..

pnpm build && pnpm test                      # full pipeline
pnpm --filter @ktrade/api start              # API on http://127.0.0.1:3001 (Swagger: /api/docs)
pnpm --filter @ktrade/web dev                # web on http://localhost:3000
```

Integration tests (real PostgreSQL via Docker): `cd apps/api && RUN_INTEGRATION=1 pnpm test`

## Documentation

- [Architecture](docs/02-architecture-plan.md) · [Decisions (ADRs)](ARCHITECTURE_DECISIONS.md)
- [Database design + ERD](docs/05-database-design.md) · [Accounting methodology](docs/06-accounting-methodology.md)
- [API specification](docs/07-api-specification.md) · [Strategy & trading engine](docs/08-strategy-and-trading-engine.md)
- [Sync & market data](docs/09-sync-and-market-data.md) · [Security & credentials](docs/04-security-and-credential-management.md)

## Disclaimer

Personal software, not financial advice. Backtest and paper-trading results are simulated and do not guarantee future returns. Tax and fee figures are estimates until confirmed by broker statements.
