# Development Status

_Last updated: 2026-11-14. Read this, `TODO.md`, `CLAUDE.md` and `ARCHITECTURE_DECISIONS.md`, then **inspect the actual code** before continuing._

## 1. Where we are

|                    |                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overall**        | Phases 1–5 done (except reconciliation and the KTrade parsers, both blocked on samples). Phase 6 + 8 core done. Phase 7 partial. Phases 9–12 not started (their pure logic exists in `finance-core`).                                                                                                                          |
| **Just completed** | **Phase 5 statement import pipeline**, API + frontend (ADR-022).                                                                                                                                                                                                                                                               |
| **Next task**      | **Phase 7:** review the agent-written `apps/api/src/market-data/*`, then seed the PSX stock list (`seed/stocks.ts` → idempotent upsert, `pnpm db:seed`). **Why first:** imports reject unknown symbols, and the `stocks` table is empty on a fresh database. Then finish MarketDataService, controller and module, with tests. |
| **Also pending**   | Repo-wide Prettier formatting as a separate style-only commit; CI `format:check` currently fails on 170 files.                                                                                                                                                                                                                 |
| **Build health**   | ✅ `pnpm turbo run build typecheck lint test`: 20/20 tasks (incl. web production build). ✅ API: 59 tests across 8 files (unit + e2e + 3 Testcontainers suites). ✅ Web: 28 tests. ✅ Compiled-API smoke test (ready 200, auth 401, 2.5 MB body parsed / 4 MB → 413, Swagger lists import routes).                             |
| **Migrations**     | 3 migrations (`init`, `auth_totp_and_hardening`, `import_target_portfolio`), all applied to the dev DB, no drift.                                                                                                                                                                                                              |
| **Git**            | `main` tracks https://github.com/numanijaz786/ktrade-automation. See `git log` for the latest commits. Push only when the owner asks.                                                                                                                                                                                          |

## 2. Completed work (cumulative)

**Phase 1–2: docs/01–09.** Feasibility (no KTrade API), browser-automation investigation (not authorized → disabled), architecture, security, DB/ERD, accounting, API spec, engine, sync and market data.

**Phase 3: foundation.**

- Monorepo (pnpm 10, Turborepo, TS 6, ESLint 10, Vitest 4, 7-day release-age guard).
- `shared`, `broker-sdk` (capability chain, disabled KTrade stubs).
- `finance-core` (184 tests): fees, ledger, returns, indicators, strategy DSL, risk, backtest.
- API skeleton, web scaffold, docker-compose (PG 16 + Valkey 8), CI.

**Phase 4: auth and security.**

- Argon2id; Ed25519 JWT; refresh rotation with reuse detection; TOTP with replay protection; step-up.
- Guard chain, VIEWER read-only, lockout, rate limiting.
- Envelope encryption, audit service, append-only triggers.

**Phase 5: imports (new).**

- `apps/api/src/imports/{imports.service,imports.controller,imports.module,imports.schemas}.ts`
- `parsers/{parser-registry,generic-csv.parser,parser.types}.ts`
- `apps/api/src/broker/{broker-accounts.service,broker.controller}.ts`
- Migration `20261114000000_import_target_portfolio`.
- `LedgerService.postTrade(…, {rebuild:false})` for batch posting; the problem+json filter now passes an allow-list of extensions (`rowNo`, `existingImportId`).
- Web:
  - `lib/api/{types,client,hooks,errors}.ts` aligned to the API contract
  - `lib/demo/csv.ts` and the demo import rules
  - `lib/demo/fixtures.ts`
  - `app/(app)/integration/page.tsx`: connections and import review UI
- Demo kill-switch default corrected to OFF.

**Phase 6 + 8: ledger, portfolio, orders.**

- LedgerService (lock + replay), FeeService, holdings, transactions, cash, dashboard summary.
- Order pipeline: preview → 14 risk checks → step-up approval bound to the preview hash → paper fill / manual live ticket → fills; kill switch; idempotency.
- docs/06 worked example verified end-to-end, through **both** the order pipeline and CSV import.

**Partial: Phase 7 market data** (agent-written, compiles, lint-clean, not wired, untested):

- `apps/api/src/market-data/*` providers (simulated, CSV-EOD, Capital Stake disabled stub), calendar, movers, staleness, registry.
- `apps/api/src/seed/stocks.ts`.

**Partial: frontend pages.** Shell, data layer and shared components exist. Pages built so far: the KTrade integration page. 18 pages remain.

## 3. Tests at last run

| Suite                                              | Result                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| finance-core / shared / broker-sdk                 | 184 / 13 / 8 ✅                                                                  |
| API unit + e2e + integration (`RUN_INTEGRATION=1`) | 59 / 59 ✅ (auth 12, trading 7, imports 8, parser 5, TOTP 13, envelope 5, e2e 9) |
| Web                                                | 28 / 28 ✅, `next build` ✅                                                      |

## 4. Known issues / blockers

| Item                                                                              | Type              | Action                                          |
| --------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------- |
| KTrade has no API; browser automation not authorized                              | ⛔ External       | Owner sends the permission request (docs/03 §6) |
| Live PSX prices need a licensed vendor (paid)                                     | ⛔ Owner decision | Simulated provider until then                   |
| KTrade contract-note / statement / CDC parsers                                    | ⛔ Input          | Need redacted samples                           |
| Tax rates                                                                         | ⛔ Input          | Placeholders `verified=false`                   |
| `stocks` table empty on a fresh DB → imports flag every symbol unknown            | Next task         | Seed the stock list (Phase 7)                   |
| `data-table.tsx` lint warning (React Compiler skips TanStack Table)               | Info              | Known library incompatibility; harmless         |
| Node 24.13 → jsdom pinned to 27                                                   | Minor             | Upgrade Node 24 LTS (ADR-015)                   |
| Dev containers left running; one `test.append_only_probe` audit row in the dev DB | Info              | `pnpm db:down` to stop                          |

## 5. Resume commands

```bash
pnpm db:up
cd apps/api && pnpm exec prisma generate && pnpm db:deploy && cd ../..
pnpm turbo run build typecheck lint test
cd apps/api && RUN_INTEGRATION=1 pnpm test   # Docker required
```

## 6. Guardrails

No deploying, spending money, registering accounts, enabling broker automation, or live financial transactions without the owner's explicit approval. Live trading: kill switch OFF, manual approval, manual placement in the KTrade app.
