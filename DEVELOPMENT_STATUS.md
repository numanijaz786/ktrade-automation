# Development Status

_Last updated: 2026-11-13 (session paused on a usage limit). Read this, `TODO.md`, `CLAUDE.md` and `ARCHITECTURE_DECISIONS.md`, then **inspect the actual code** before continuing._

## 1. Where we are

| | |
|---|---|
| **Overall** | Phases 1–4 done. Phases 5–8 partly done. Phases 9–12 not started (their pure logic already exists in `finance-core`). |
| **Current task** | **Phase 5: statement import pipeline (`apps/api/src/imports/`)** |
| **Exact stopping point** | The parser layer is done and tested: `imports/parsers/parser.types.ts`, `imports/parsers/generic-csv.parser.ts`, plus 5 passing tests. **Not yet written:** `imports.service.ts`, `imports.controller.ts`, `imports.module.ts`, `parser-registry.ts`, wiring into `app.module.ts`, and `test/imports.int.test.ts`. |
| **Build health at pause** | ✅ `pnpm turbo run build typecheck lint test` over packages + API: 16/16 tasks pass. ✅ API integration (real Postgres): 19/19. ✅ Web: typecheck 0 errors, lint 0 errors (3 warnings), 26 tests, `next build` succeeds. |
| **Migrations** | 2 migrations, both applied to the dev DB, **no drift** (`prisma migrate diff` empty). No incomplete migration exists. |
| **Git** | Repo initialised (`main`). **Nothing committed yet**, and all work is on disk. Recommended first step when resuming: a baseline commit (ask the owner). |

## 2. Completed work

### Phase 1–2: research & design (`docs/`)
- `01` KTrade feasibility: no official API.
- `02` architecture.
- `03` browser-automation investigation: no written permission, so the adapter is disabled.
- `04` security.
- `05` DB design + ERD.
- `06` accounting.
- `07` API spec.
- `08` strategy and trading engine.
- `09` sync and market data.

### Phase 3: foundation
- pnpm 10 + Turborepo monorepo, TypeScript 6, ESLint 10, Prettier, Vitest 4. Supply-chain guard: 7-day `minimumReleaseAge`.
- `packages/shared`: enums mirroring Prisma (sync test), decimal-string Zod schemas, auth schemas.
- `packages/broker-sdk`: capability chain, `guardedCall`, `BrokerAdapter`/`MarketDataProvider` interfaces, disabled KTrade stubs.
- `packages/finance-core` (184 tests), all pure and decimal-exact:
  - fees: KTrade schedule, day-trade rule, tax lookup
  - ledger: WAC/FIFO, lots, bonus/split/rights, dividends, eligibility
  - returns: valuation, TWR, XIRR, drawdown
  - indicators: SMA/EMA/WMA/RSI/MACD/ATR/BB/ROC
  - strategy: rule DSL, templates, evaluator, sizer, scoring
  - risk: 14 rules + preview hash
  - backtest: no-look-ahead simulator, metrics, paper fills
- `apps/api`: NestJS 12 ESM, Prisma 7 (adapter-pg), config validation, pino logging with redaction, RFC 9457 errors, `/health` + `/ready`, Swagger at `/api/docs`.
- `apps/web`: Next 16, Tailwind 4, shadcn/ui (Radix, 32 components).
- `infra/docker-compose.yml`: Postgres 16 + Valkey 8 on 127.0.0.1.
- `.github/workflows/ci.yml`, `.env.example`, `CLAUDE.md`, `ARCHITECTURE_DECISIONS.md` (ADR-001…021).

### Phase 4: auth, security, audit
- Argon2id, Ed25519 JWT, rotating refresh tokens with reuse detection, TOTP (RFC 6238 vectors) with replay protection, step-up tokens.
- Global guard chain (Throttler → JwtAuth → Roles → StepUp), VIEWER read-only, lockout.
- Envelope encryption (AES-256-GCM) and an audit service.
- Migration 2: CHECK constraints, a partial unique index, and **append-only triggers** on `audit_logs` and `order_events`.

### Phase 6 + 8 (core): ledger, portfolio, order pipeline
- `ledger/ledger.service.ts`: advisory lock + full per-symbol replay.
- `ledger/fee.service.ts`: DB schedule, or KTrade default.
- `portfolio/*`: portfolios, paper portfolio creation, holdings with valuation, transactions, cash, risk limits, `GET /dashboard/summary` with provenance.
- `trading/*`:
  - preview → 14 risk checks → step-up approval bound to the preview hash (5-min expiry)
  - paper fills
  - live **manual ticket** (`AWAITING_MANUAL_PLACEMENT` → mark-placed → record fill)
  - cancel, list/get
  - kill switch (default OFF)
  - idempotency keys
- **docs/06 worked example reproduced end-to-end through HTTP + Postgres** (`test/trading.int.test.ts`).

### Partial work from stopped agents (compiles, lint-clean, NOT wired in)
- **Market data (Phase 7)** in `apps/api/src/market-data/`: `providers/simulated.provider.ts`, `providers/csv-eod.provider.ts`, `providers/capital-stake.provider.ts` (disabled stub), `csv-eod.parser.ts`, `calendar.ts`, `market-calendar.service.ts`, `movers.ts`, `staleness.ts`, `prices.repository.ts`, `provider-registry.ts`, `rng.ts`, `decimal-format.ts`, `errors.ts`; `apps/api/src/seed/stocks.ts`.
  **Missing:** `MarketDataService`, controller, `market-data.module.ts`, seed routine (`seedMarketData`), unit + integration tests, wiring into `app.module.ts`. These files were written by an agent that was cut off: **review them before building on them.**
- **Frontend (Phase 3/UI)** in `apps/web/src/`:
  - Data layer: `lib/api/{types,client,demo-client,hooks,errors}.ts`, `lib/demo/*`.
  - Shell: `components/shell/*` (sidebar, mobile nav, banners, theme toggle).
  - Components: `provenance-badge`, `money`, `stat-tile`, `data-table`, `status-badge`, `step-up-dialog`, `states`, `page-header`.
  - Format helpers + tests (26 passing).
  **Missing:** the 19 pages (only `(app)/page.tsx` and the layouts exist).
  **Review item:** `lib/decimal.ts`, `lib/fees.ts` and `lib/indicators.ts` duplicate `@ktrade/finance-core`. Replace them with imports from the package (add it as a web dependency).

## 3. Tests executed (at pause)
| Suite | Result |
|---|---|
| `@ktrade/finance-core` | 184 / 184 ✅ |
| `@ktrade/shared` | 13 / 13 ✅ |
| `@ktrade/broker-sdk` | 8 / 8 ✅ |
| `@ktrade/api` unit + e2e (stubbed infra) | 32 / 32 ✅ (incl. TOTP RFC vectors, envelope crypto, rate limiting, CSV parser) |
| `@ktrade/api` integration (`RUN_INTEGRATION=1`, Testcontainers) | auth 12 / 12 ✅, trading 7 / 7 ✅ |
| `@ktrade/web` | 26 / 26 ✅; `next build` ✅ |
| Compiled API smoke test (`node dist/main.js` vs real PG + Valkey) | ✅ health / ready / docs / 404 / loopback bind (earlier in Phase 3; re-run after wiring new modules) |

## 4. Known issues / blockers
| Item | Type | Action |
|---|---|---|
| KTrade has no API; browser automation not authorized | **Blocked (external)** | Owner sends the permission request (docs/03 §6). Adapters stay disabled. |
| Live PSX prices need a licensed vendor (paid) | **Blocked (owner decision, payment)** | Simulated provider until then. Never scrape. |
| KTrade contract-note / statement parsers | **Blocked (input)** | Need redacted sample files from the owner. |
| Tax rates (CGT, dividend WHT) | **Blocked (input)** | Seeded as `verified=false` placeholders. Owner to confirm. |
| Node 24.13 < 24.15 → jsdom pinned to 27 | Minor | Owner may upgrade Node 24 LTS (ADR-015). |
| Throttler is in-memory | Known limit | Switch to a Redis store before running more than 1 API instance. |
| Dev containers `ktrade-postgres-1`, `ktrade-redis-1` left running | Info | `pnpm db:down` to stop (data persists in volumes). |
| One probe row `test.append_only_probe` in the dev audit log | Info | Intentional evidence that the trigger works; cannot be deleted (append-only). |

## 5. How to resume (commands)
```bash
pnpm db:up                                            # Postgres + Valkey
cd apps/api && pnpm exec prisma generate && pnpm db:deploy
cd ../.. && pnpm turbo run build typecheck lint test  # must be green before new work
cd apps/api && RUN_INTEGRATION=1 pnpm test            # needs Docker
```
Then continue with the **first unchecked item in `TODO.md`**.

## 6. Guardrails (unchanged)
Do not deploy, spend money, register accounts, enable broker automation, or execute live financial transactions without the owner's explicit approval. Live trading stays: kill switch OFF, manual approval, manual placement in the KTrade app.
