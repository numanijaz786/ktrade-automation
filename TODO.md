# TODO

Legend: `[x]` done and verified · `[~]` partial (see note) · `[ ]` not started · ⛔ blocked on the owner or an external party.
Work top to bottom; the first unchecked item is the next task.

## Phase 1–2: Research & design
- [x] KTrade feasibility report (docs/01)
- [x] Browser-automation investigation (docs/03) + permission-request draft
- [x] Architecture, ERD, accounting, API spec, engine, sync/market-data, security docs (docs/02, 04–09)
- [x] Prisma schema validated + applied on PostgreSQL 16

## Phase 3: Foundation
- [x] Monorepo (pnpm 10, Turborepo, TS 6, ESLint 10, Prettier, Vitest), supply-chain guard
- [x] packages/shared, packages/broker-sdk (+ disabled KTrade stubs)
- [x] packages/finance-core: fees, ledger, returns (financial engineer)
- [x] packages/finance-core: indicators, strategy DSL, risk, backtest (quant engineer)
- [x] API skeleton (config, logging, problem+json, health/ready, Swagger), compiled smoke test
- [x] Web scaffold (Next 16, Tailwind 4, shadcn/Radix), docker-compose (PG 16 + Valkey 8), CI workflow
- [x] CLAUDE.md, ARCHITECTURE_DECISIONS.md, .env.example

## Phase 4: Auth & security
- [x] Argon2id, Ed25519 JWT, refresh rotation + reuse detection, TOTP + replay protection, step-up
- [x] Guard chain, RBAC (VIEWER read-only), lockout, rate limiting
- [x] Envelope-encryption vault primitives, audit service
- [x] Migration: CHECK constraints + append-only triggers
- [x] Integration tests (12) on real Postgres
- [ ] Credential-vault service + `/integrations/credentials` endpoints (write-only secrets)
- [ ] `POST /security/destroy-all` (sessions + vault crypto-shred)
- [ ] Seed script (`pnpm db:seed`): owner-less demo data, KTrade fee schedule, placeholder tax rates (`verified=false`), PSX holidays

## Phase 5: Broker abstraction & imports  ← **CURRENT**
- [x] Parser interface + generic transactions CSV parser (+5 tests)
- [ ] **NEXT: `imports.service.ts`**: upload (sha256 dedupe → 409), parse → `imported_rows` with fingerprints, unknown-symbol/duplicate detection, review, commit in one DB transaction via `LedgerService.postTrade` (estimate fees when absent), reject; audit
- [ ] `imports.controller.ts` (`POST /imports`, `GET /imports`, `/imports/:id`, `/imports/:id/rows`, `PATCH rows`, `POST commit/reject`), `parser-registry.ts`, `imports.module.ts`, wire into `app.module.ts`
- [ ] `test/imports.int.test.ts` (import → commit → holdings; duplicate file; invalid rows; oversell aborts whole commit)
- [ ] Reconciliation: match confirmed rows to USER_REPORTED fills → upgrade to BROKER_CONFIRMED (docs/06 §8)
- [ ] ⛔ KTrade contract-note / ledger / CDC parsers: needs redacted samples
- [ ] Mailbox ingestion (OAuth read-only), after the contract-note parser exists
- [ ] Paper broker adapter as a `BrokerAdapter` + adapter contract-test suite

## Phase 6: Portfolio & transactions
- [x] LedgerService (lock + replay), FeeService, holdings with valuation, transactions, cash, dashboard summary
- [x] docs/06 worked example verified end-to-end
- [ ] Manual transaction entry endpoint + reversal endpoint
- [ ] Corporate actions endpoints (bonus/split/rights apply)
- [ ] Holding detail (lots, history) endpoint

## Phase 7: Market data
- [~] Providers written by an agent (simulated, CSV-EOD, Capital Stake disabled stub), calendar, movers, staleness, registry, seed stock list. **Review first**; they compile and lint clean but have no tests yet
- [ ] MarketDataService + controller (`/market/*`, `/watchlists`), module, wiring
- [ ] `seedMarketData` (≈30 PSX symbols, 2 years of SIMULATED D1 bars) + quote ticker (`MARKET_DATA_TICKER`)
- [ ] Unit + integration tests
- [ ] WebSocket gateway (`quote`, `order.updated`, `notification`)
- [ ] ⛔ Live/delayed data: owner chooses and pays for a licensed vendor

## Phase 8: Trading
- [x] Preview, 14 risk checks, step-up approval + preview hash, paper fills, manual live ticket, record fill, cancel, kill switch, idempotency
- [x] Integration tests (7)
- [ ] Working-order matcher for non-marketable paper limit orders (BullMQ)
- [ ] Preview/approval expiry sweeper job

## Phase 9: Strategies, backtesting, paper trading
- [ ] Strategies CRUD + templates endpoint (finance-core templates exist)
- [ ] Scheduled evaluation (BullMQ), signals persistence, signal → prepared order
- [ ] Backtest jobs + results endpoints
- [ ] Open items from ADR-020: VWAP, walk-forward, regime / multi-timeframe filters, STOP orders in paperFill

## Phase 10: Alerts, notifications, dividends, analytics
- [ ] Portfolio snapshots (EOD) → today's/monthly P&L, TWR/XIRR in the dashboard
- [ ] Alerts engine + notifications (in-app, email, Telegram)
- [ ] Dividends (declarations, entitlements, WHT, reconcile)
- [ ] Analytics endpoints + PDF/CSV/XLSX exports

## Phase 11: AI assistant
- [ ] LLM provider abstraction, read-only tools, citations, opt-in (⛔ needs an LLM API key from the owner)

## Frontend (runs alongside)
- [x] Data layer (ApiClient + DemoApiClient + hooks), app shell, nav, banners, provenance badge, shared components, tests (26)
- [ ] 19 pages (priority: Dashboard, Holdings, Buy/Sell flow, Market Watch, Stock Details, Strategies, Backtesting, KTrade Integration; then the rest)
- [ ] Replace `lib/decimal.ts`, `lib/fees.ts`, `lib/indicators.ts` with `@ktrade/finance-core` (remove duplication)
- [ ] `HttpApiClient` + Next BFF route handlers (httpOnly cookies, CSRF), auth pages wired to the real API

## Phase 12: Hardening & delivery
- [ ] Production Dockerfiles + compose (api, worker, web, nginx TLS, migrate job)
- [ ] Security review (OWASP), dependency audit, gitleaks pre-commit
- [ ] README, deployment guide, security documentation finalisation
- [ ] Paper-trading demonstration script
