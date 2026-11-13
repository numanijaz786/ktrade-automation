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
- [x] Seed script (`pnpm db:seed`): PSX stocks + SIMULATED history + KTrade fee schedule (idempotent). Tax rates deliberately NOT seeded (ADR-023)
- [ ] PSX holiday calendar seed (needs an authoritative holiday list; the owner can enter it via settings)

## Phase 5: Broker abstraction & imports

- [x] Parser interface + generic transactions CSV parser (+5 tests)
- [x] `imports.service.ts`: upload, sha256 dedupe (+ race-safe), parse, unknown-symbol / duplicate (prior import + ledger + in-file ref) detection, review (skip/include), atomic commit via `LedgerService` (one rebuild per symbol), fee estimates labelled ESTIMATED, reject, audit
- [x] `imports.controller.ts`, `parser-registry.ts`, `imports.module.ts`, wired; migration 3 (`imported_statements.portfolioId`)
- [x] `POST/GET /broker/accounts` (KTrade account + LIVE portfolio, adapters disabled)
- [x] `test/imports.int.test.ts` (8): success + docs/06 accuracy, duplicate file, duplicate trades, invalid rows, review, full rollback on oversell, validation, audit
- [x] Frontend: ApiClient import contract aligned with the API, demo client mirrors the rules, KTrade integration page (connections + import review UI), demo test
- [ ] Reconciliation: match BROKER_CONFIRMED rows to USER_REPORTED fills → upgrade (docs/06 §8). Needs a broker-confirmed parser first
- [ ] ⛔ KTrade contract-note / ledger / CDC parsers: needs redacted samples
- [ ] Mailbox ingestion (OAuth read-only), after the contract-note parser exists
- [ ] Paper broker adapter as a `BrokerAdapter` + adapter contract-test suite

## Phase 6: Portfolio & transactions

- [x] LedgerService (lock + replay), FeeService, holdings with valuation, transactions, cash, dashboard summary
- [x] docs/06 worked example verified end-to-end
- [ ] Manual transaction entry endpoint + reversal endpoint
- [ ] Corporate actions endpoints (bonus/split/rights apply)
- [ ] Holding detail (lots, history) endpoint

## Phase 7: Market data (API done)

- [x] Review of agent-written market-data code: accepted (ADR-023)
- [x] `seedMarketData` (30 PSX symbols, SIMULATED D1 history, never overwrites real rows) + seed integration tests (4)
- [x] Unit tests for the reviewed providers (calendar, simulated determinism/tick/OHLC, CSV parser, staleness, movers, vendor stub) + Zod 4 refinement regression tests
- [x] MarketDataService + controllers: overview, stocks (search/sector/pagination), details (52w, avg volume, provenance), quotes (persisted to `stock_quotes`), candles, sectors, movers, providers (🔐 switch), EOD price import; quote ticker (`MARKET_DATA_TICKER`)
- [x] Watchlists API (CRUD, idempotent add, per-user isolation, limits)
- [x] Integration test (8) incl. paper-order preview priced from persisted quotes and "real beats simulated"
- [ ] Frontend: market overview, stock explorer/details, watchlists pages wired to the real API (see Frontend: BFF + HttpApiClient)
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
- [ ] **NEXT: Next BFF route handlers (httpOnly cookies, CSRF) + `HttpApiClient` + login/register pages**: the web app currently runs only on the demo client, so no real API data reaches the browser. Then wire market overview / explorer / stock details / watchlists / integration pages to it

## Repo hygiene

- [x] Apply Prettier repo-wide (style-only commit; CI `format:check` now passes)

## Phase 12: Hardening & delivery

- [ ] Production Dockerfiles + compose (api, worker, web, nginx TLS, migrate job)
- [ ] Security review (OWASP), dependency audit, gitleaks pre-commit
- [ ] README, deployment guide, security documentation finalisation
- [ ] Paper-trading demonstration script
