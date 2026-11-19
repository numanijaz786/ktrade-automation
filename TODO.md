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
- [x] Frontend: market overview, stock explorer/details, watchlists on the real API
- [ ] WebSocket gateway (`quote`, `order.updated`, `notification`)
- [ ] ⛔ Live/delayed data: owner chooses and pays for a licensed vendor

## Phase 8: Trading

- [x] Preview, 14 risk checks, step-up approval + preview hash, paper fills, manual live ticket, record fill, cancel, kill switch, idempotency
- [x] Integration tests (7)
- [ ] Working-order matcher for non-marketable paper limit orders (BullMQ)
- [ ] Preview/approval expiry sweeper job

## Phase 9: Strategies, backtesting, paper trading

- [x] Strategies CRUD + templates + DSL validation + dry-run (ADR-025)
- [x] Manual evaluation → signals (deduped) + execution log; PAPER autoExecute → system paper approval (PAPER-only, risk-checked); LIVE → signal only
- [x] Backtests (real KTrade fees, provenance, disclaimer) + compare; Sortino, annualised return, risk/reward
- [x] Integration tests (13)
- [x] Scheduled evaluation at bar close (STRATEGY_SCHEDULER, try-lock + run log, LIVE never orders) + `prepare-order` (preview only) / `dismiss` / expiry (ADR-030)
- [x] Frontend: strategies, backtesting, paper trading on the real API
- [ ] Open items from ADR-020/025: VWAP, walk-forward, regime / multi-timeframe filters, STOP orders in paperFill, mirror mode

## Phase 10: Alerts, notifications, dividends, analytics

- [x] Portfolio snapshots (ledger replay + D1 closes, provenance), backfill, scheduler; performance endpoint (TWR, drawdown, monthly, simple, XIRR); summary today/month P&L with explicit basis (ADR-027)
- [x] Alerts CRUD + evaluator (cooldown, triggerOnce, dedupe) + scheduler; in-app notifications; order/signal notifications; email/Telegram adapters disabled
- [x] Risk engine DAILY_LOSS fed from real today P&L (ADR-028) + integration test
- [ ] Make summary accountValue treat unquoted holdings consistently with snapshots (at cost, ESTIMATED)
- [x] Dividends: declarations, entitlements (settled before book closure, T+n), verified-only WHT, mark-paid (WHT required), reconcile (ADR-031)
- [x] Frontend: dividends page on the real API
- [ ] Analytics endpoints + PDF/CSV/XLSX exports
- [ ] ⛔ Email/Telegram delivery: owner configures channels (USER_ACTION #6)

## Phase 11: AI assistant

- [ ] LLM provider abstraction, read-only tools, citations, opt-in (⛔ needs an LLM API key from the owner)

## Frontend (runs alongside)

- [x] Data layer (ApiClient + DemoApiClient + hooks), app shell, nav, banners, provenance badge, shared components, tests (26)
- [ ] 19 pages (priority: Dashboard, Holdings, Buy/Sell flow, Market Watch, Stock Details, Strategies, Backtesting, KTrade Integration; then the rest)
- [ ] Replace `lib/decimal.ts`, `lib/fees.ts`, `lib/indicators.ts` with `@ktrade/finance-core` (remove duplication)
- [x] BFF route handlers (httpOnly cookies, CSRF, refresh-once), HttpApiClient (NOT_AVAILABLE for unbuilt features, no demo fallback), login/register (ADR-026)
- [x] Real-data pages: market overview, explorer, stock details (candles), watchlists, KTrade integration (account + imports)
- [x] Step-up dialog: password option when TOTP is not enabled
- [x] Dashboard, holdings, transactions, buy/sell (full approval + manual ticket), orders, strategies, backtests, settings kill switch (ADR-029)
- [x] Dashboard performance (TWR, drawdown, monthly, XIRR, basis tooltips, backfill), notifications bell + page, alerts page (all types)

## Repo hygiene

- [x] Apply Prettier repo-wide (style-only commit; CI `format:check` now passes)

## Phase 12: Hardening & delivery

- [x] Production Dockerfiles + compose (api, migrate, web, nginx TLS; DB/cache internal only), backups/restore, deployment guide + go-live checklist, verified locally 32/32 (ADR-032)
- [x] Real client IP BFF → API with trusted-proxy handling (ADR-033)
- [ ] CSP nonces (drop 'unsafe-inline'); slim the API image
- [x] ASVS L2 self-review + dependency audit (ADR-033, docs/11)
- [ ] Close ASVS gaps: absolute session lifetime, TOTP required for OWNER, breached-password check, `pnpm audit` in CI, csv-parse 7
- [ ] ⛔ Deploy: owner approves VPS + domain (USER_ACTION #5), then follow DEPLOYMENT_GUIDE.md
- [ ] Paper-trading demonstration script

## Research & advisor (AI Investment Advisor)

- [x] Data layer: financials, announcements, macro, provider status/registry (honest disabled stubs), immutable recommendations + outcomes, outcome evaluator, performance (ADR-034)
- [x] Pure research engine in finance-core: technicals, ratios, valuation, recommendation rules with hard data gating, holdings advice, scanner (ADR-035, docs/12; 295 finance-core tests)
- [ ] Backtest the default rule thresholds on real historical data once available (thresholds are untuned)
- [x] Advisor API (daily report, holdings advice, scanner, stock report, settings), explanation layer (template, LLM stub disabled), after-close scheduler + dedup alerts (ADR-036)
- [ ] Per-portfolio sizing for multiple portfolios on the same bar; valuation assumptions storage (DDM/DCF); real ex-dividend dates
- [x] Frontend (already built): Market intelligence, Financial statements, Data providers & system health, Recommendation history/performance
- [ ] **NEXT: Frontend advisor pages: AI Advisor dashboard (daily report), Buy opportunities, Sell & exit signals, My portfolio manager, Stock research report, Scanner, Risk settings (risk per trade %)**
- [ ] Alerts for entry range / targets / stop / recommendation change / news
- [ ] ⛔ Real prices: Capital Stake quote or licensed EOD source (USER_ACTION #3) — until then every recommendation is NOT_ACTIONABLE by design
- [ ] ⛔ SBP EasyData key (USER_ACTION #8); LLM key for the explanation layer (USER_ACTION #7)
