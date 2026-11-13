# Architecture Decision Records

Format: **Context → Decision → Alternatives considered → Consequences.** Newest last. Status is Accepted unless stated.
Versions were checked against the npm registry on 2026-11-13.

---

## ADR-001 · Monorepo with pnpm workspaces + Turborepo

- **Context:** The API, worker, web app and pure domain packages share types, enums and financial logic.
- **Decision:** One repo. `apps/*` (api, web, later worker and browser-agent) and `packages/*` (finance-core, shared, broker-sdk). pnpm 10.34 (pinned via `packageManager`, activated by corepack). Turborepo 2 for task graph and caching.
- **Alternatives:**
  - npm workspaces: slower, no strict isolation.
  - Nx: heavier and more opinionated than this project needs.
  - Separate repos: type drift between frontend and backend.
- **Consequences:** Shared code is built (`tsc`) before its consumers run (`dependsOn: ^build`).

## ADR-002 · Supply-chain guard: `minimumReleaseAge` = 7 days, allow-listed install scripts

- **Context:** Compromised npm releases are usually caught within days.
- **Decision:** `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, so a version is never resolved until it is a week old. `onlyBuiltDependencies` allow-lists the few packages permitted to run install scripts.
- **Consequences:** A brand-new release (e.g. Next 16.4.6, 3 days old at setup) is deliberately skipped in favour of 16.4.5. Urgent security patches need a documented one-off override.

## ADR-003 · TypeScript 6.0 (not 7.0)

- **Context:** TS 7 (native Go compiler, Jul 2026) drops the JS compiler API that typescript-eslint and other tooling rely on. typescript-eslint 8.72 supports TS `<6.1`.
- **Decision:** TypeScript `~6.0.3`, strict, plus `noUncheckedIndexedAccess`, ESM `NodeNext`.
- **Revisit when:** typescript-eslint supports TS 7.

## ADR-004 · NestJS 12, ESM

- **Context:** NestJS 12 (Aug 2026) is current, with native ESM. v11 is now tagged `legacy`. The release was checked against the official migration guide and its notes; every Nest module we use declares v12 support.
- **Decision:** Nest 12 in an ESM project (`"type": "module"`, `.js` import suffixes). Built with plain `tsc` (decorator metadata); dev runs `node --watch dist/main.js`.
- **Alternatives:**
  - Nest 11 (CJS): stable, but already legacy.
  - Fastify adapter: unnecessary for single-user load; Express has the broadest middleware ecosystem.
- **Consequences:** Path aliases are avoided (they break under ESM); workspace packages are used instead.

## ADR-005 · Prisma 7 with the `prisma-client` generator + `@prisma/adapter-pg`

- **Context:** Prisma 7 is the stable line (8 is still a release candidate). It moves the connection URL to `prisma.config.ts` and generates TypeScript source.
- **Decision:**
  - The client is generated into `apps/api/src/generated/prisma` (gitignored) with `moduleFormat = "esm"` and **`importFileExtension = "js"`**.
  - It runs on the node-postgres driver adapter.
  - Migrations are explicit SQL produced by `prisma migrate diff` and applied with `migrate deploy`, the same path as production.
- **Incident (fixed):** without `importFileExtension = "js"`, the generated client imports `./internal/class.ts`, which crashes plain Node at runtime. Vitest hid this because it resolves `.ts`; it was caught by the real smoke test. Lesson: always smoke-test the compiled build.
- **Alternatives:** Drizzle (excellent, but the requirement specifies Prisma); TypeORM (weaker typing).

## ADR-006 · Decimal-exact money: decimal.js, strings at every boundary

- **Decision:**
  - All money, price, quantity and rate maths uses `decimal.js` through an isolated clone (precision 34, HALF_EVEN) in `@ktrade/finance-core`.
  - Values cross HTTP, WebSocket and queues as decimal **strings**; the DB uses `NUMERIC`.
  - ESLint bans `parseFloat`, `Number()`, `Math.*` and `Decimal#toNumber()` in finance-core source.
  - A named import (`import { Decimal } from 'decimal.js'`) is used because the package's CJS-style typings make the default import resolve to the namespace under NodeNext.
- **Alternatives:**
  - big.js: smaller, but lacks `sqrt`/`ln`, which are needed for Sharpe and XIRR.
  - Integer paisa (bigint): awkward for 6-dp prices and rates.

## ADR-007 · Single test framework: Vitest 4 everywhere

- **Decision:**
  - Vitest for packages, API and web.
  - The API uses `unplugin-swc`, so decorator metadata exists in tests.
  - API e2e tests run through the real `configureApp()` HTTP pipeline, with infrastructure stubbed.
  - `*.int.test.ts` (Testcontainers, real Postgres) is opt-in via `RUN_INTEGRATION=1`.
- **Alternatives:** Jest 30 (Nest's historical default). Two frameworks would double configuration and knowledge.

## ADR-008 · Validation with Zod 4 (shared schemas), errors as RFC 9457 problem+json

- **Decision:**
  - Request schemas live in `@ktrade/shared` and are used by both the web forms and the API (`ZodValidationPipe`).
  - A global `ProblemDetailsFilter` maps Zod errors (422), broker capability errors (409), HTTP exceptions and unknown errors (generic 500, details only in logs).
- **Alternatives:** class-validator DTOs, which would duplicate schemas that the frontend already needs.

## ADR-009 · Valkey 8 instead of Redis

- **Context:** Redis ≥ 7.4 is under source-available or AGPL licences. Valkey is the Linux Foundation's BSD-3 fork, protocol-compatible with ioredis and BullMQ.
- **Decision:** `valkey/valkey:8-alpine`, with AOF persistence and `noeviction` (required for durable BullMQ queues). Bound to 127.0.0.1.
- **Note:** The client code is unchanged, so a managed Redis can be swapped in at deploy time.

## ADR-010 · Redis client lifecycle: lazy connect, explicit non-blocking `connect()`

- **Incident (fixed):** `lazyConnect` + `enableOfflineQueue:false` meant the socket never opened, so `/ready` always reported Redis down. Caught by the smoke test.
- **Decision:** connect at `onModuleInit` without awaiting. The app starts even if Redis is down, reports `/ready` 503, and ioredis keeps retrying.

## ADR-011 · Logging: nestjs-pino with redaction and request ids

- **Decision:**
  - Structured JSON logs.
  - Auth headers, cookies, tokens, passwords and secrets are redacted.
  - A well-formed inbound `x-request-id` is echoed back; otherwise a UUID is minted.
  - `/health` and `/ready` are excluded from access logs.

## ADR-012 · Health endpoints without @nestjs/terminus

- **Decision:** `/health` (liveness, no dependencies) and `/ready` (DB `SELECT 1` + Redis `PING` → 200/503, booleans only).
- **Why:** Two probes don't justify a dependency (ADR principle: no dependency without clear benefit).

## ADR-013 · Broker capability chain (implemented ∧ verified ∧ authorized ∧ enabled)

- **Decision:**
  - Every broker call goes through `guardedCall(adapter, method, …)`. The capability is derived from the method name, so a caller can't pair a method with the wrong capability.
  - `authorized` additionally requires an `authorizationRef` (KTrade's written permission).
  - Both KTrade adapters are stubs with every capability off, and tests assert that they refuse every operation.
- **Consequences:** Enabling live automation later is a configuration change through the chain, not a redesign (docs/02 §5, docs/03).

## ADR-014 · Frontend stack

- **Decision:**
  - Next.js 16 (App Router, Turbopack), React 19.3, Tailwind 4.
  - shadcn/ui with **Radix** primitives (Nova preset). Radix was chosen over Base UI and React Aria for maturity and its accessibility record.
  - TanStack Query (server state), TanStack Table (tables), react-hook-form + Zod (forms).
  - Charts: lightweight-charts 5 (price and equity) and Recharts 3 (allocation, bars).
  - next-themes and sonner.
- **State management:** none beyond TanStack Query and React local state. A global client store isn't justified.
- **Data layer:** UI → `ApiClient` interface → `DemoApiClient` (SIMULATED, until the backend exists) or `HttpApiClient` (BFF). Pages never call `fetch` directly.
- **Fix applied:** shadcn's `use-mobile` hook rewritten with `useSyncExternalStore` (the generated version set state inside an effect).

## ADR-015 · jsdom 27 pinned (Node 24.13 on this machine)

- **Context:** jsdom ≥ 30 requires Node ≥ 24.15. The installed Node is 24.13.0.
- **Decision:** pin `jsdom@^27`.
- **Action for owner:** upgrade to the latest Node 24 LTS at your convenience, then lift the pin.

## ADR-016 · ESLint 10 flat config

- **Context:** ESLint 9 is end-of-life (the npm deprecation notice says so).
- **Decision:** ESLint 10 + typescript-eslint 8 + eslint-config-prettier at the root; `eslint-config-next` in the web app.

## ADR-017 · Specialist-agent delegation boundaries

- **Decision:**
  - Parallel agents own **disjoint directories**:
    - finance-core `fees/ledger/returns` (financial engineer)
    - finance-core `indicators/strategy/risk/backtest` (quant engineer)
    - `apps/web` (frontend engineer)
  - Only the lead engineer installs dependencies, so the shared lockfile is never written concurrently.
  - The lead reviews and integrates every contribution and runs the full pipeline.

## ADR-018 · Accounting decisions made during implementation (finance-core)

Refinements to docs/06, decided by the financial engineer and accepted:

1. Realized-P&L invariant: for a fully closed position, total realized = Σ net proceeds − Σ cost added, under both WAC and FIFO (fees, bonus and splits included). Property-tested.
2. Lots are always consumed FIFO, even in WAC mode, so FIFO and tax-lot views are always available.
3. Bonus shares are allocated across lots by largest remainder and dated from the parent lot by default (configurable).
4. Splits floor whole shares and report the fraction. A reverse split to 0 shares writes the cost off to realized.
5. **Dividend eligibility:** a trade qualifies if it **settles strictly before** book-closure start, i.e. the last cum-date is T−(n+1) trading days. This corrects the wording in docs/06 §6.
6. `effectiveTo` and the holding-day bounds are inclusive. Overlapping tax rates with the same start date throw rather than guess. An UNKNOWN filer falls back to NON_FILER rates (the conservative choice; configurable).
7. SECP/PSX levies and CVT are AT_ACTUAL items in the default KTrade schedule.
8. XIRR solves in growth-factor space for robust convergence.

## ADR-019 · Authentication design (Phase 4)

- **Access tokens:** Ed25519 (EdDSA) JWTs via `jose`, 15 min, carrying a `sid` (session = refresh-token family). The global `JwtAuthGuard` also checks that the session is still live, so revoking a session, logging out or changing the password takes effect **immediately**. The cost is one indexed query per request, which is acceptable for a single-user system. A partial index `refresh_tokens_live_family` covers it.
- **Refresh tokens:** opaque 256-bit tokens, stored only as SHA-256. Each one is rotated on every use with a conditional `updateMany` (race-safe). **Reusing a rotated token revokes the whole family** and writes `auth.refresh_reuse_detected`. Cookie: `ktrade_rt`, HttpOnly, SameSite=Strict, Path=`/api/v1/auth`, Secure (configurable for http://localhost dev).
- **Passwords:** Argon2id (m=64 MiB, t=3, p=1). Hashes are upgraded on login when the parameters change. Unknown emails take the same time to check as known ones (dummy hash), and both return the same error, so emails can't be enumerated. 5 failures → 15-minute lock (423).
- **TOTP:** RFC 6238 on `node:crypto` (verified against the RFC Appendix B vectors), ±1 step skew. The **last accepted step is persisted, so a code can't be replayed**. Secrets are envelope-encrypted with AAD bound to the user.
- **Step-up:** 🔐 routes require `X-Step-Up-Token`, a 5-minute JWT with its own audience, so it can never be used as an access token.
- **Authorization:** the global guard chain is registered explicitly in AppModule: Throttler → JwtAuth → Roles → StepUp. It is default-deny: routes need `@Public()` to opt out. VIEWER is read-only unless a route opts in with `@AllowViewerWrite()`.
- **Registration:** open only until the first OWNER exists. The check runs in a SERIALIZABLE transaction.
- **Rate limiting:** an in-memory throttler (120/min default; 5/min on login, register and step-up). Correct for one API instance; **switch to a Redis-backed store before running more than one instance.**
- **Audit:** writes are awaited and fail closed. Secret-looking keys are scrubbed recursively. `audit_logs` and `order_events` are **append-only, enforced by DB triggers** (UPDATE, DELETE and TRUNCATE raise), which holds for every DB role.
- **Lesson (tests):** ConfigModule captures env at import time, so integration tests import app modules dynamically after the Testcontainers URL is set. The Argon2 policy now lives in a dependency-free module so that importing it doesn't load config early. `overrideGuard` can't override `APP_GUARD` guards, so tests disable throttling through `getOptionsToken()` → `skipIf`.

## ADR-020 · Quant engine conventions (finance-core indicators/strategy/risk/backtest)

Accepted from the quant engineer's implementation:

1. Indicators are tested against **exact** values (e.g. RSI 70.46, not StockCharts' 70.53, which comes from intermediate rounding). A flat window gives RSI 50. EMA is seeded with an SMA; ATR needs period+1 bars; Bollinger uses population σ.
2. All `*Pct` inputs are percentages (5 = 5%).
3. Stop-loss, trailing-stop and take-profit overlays act as soon as a position exists, even during indicator warm-up. Rule-based signals wait for full warm-up.
4. Cooldown is counted from the bar where the position goes flat.
5. DSL additions: an operand offset (`HIGHEST(20)[1]`) and strict `rising/falling(n)`.
6. Risk engine: the order-value limit excludes fees, while buying power uses the fee-inclusive estimate. A zero reference price or zero portfolio value **fails** the check (fail closed). 14 rules.
7. Backtest: signal at close t → fill at open t+1 (no look-ahead, property-tested). Buy-and-hold uses the same costs. Sharpe annualisation must match the bar interval. Profit factor is null when there are no losing trades.
8. **Not yet built:** VWAP, walk-forward splits, the multi-timeframe and market-regime filters, and STOP orders in `paperFill`. Tracked for Phase 9.

## ADR-021 · Ledger posting & order pipeline (Phases 6 + 8)

- **Ledger posting = lock + insert + full per-symbol replay.** `LedgerService.postTrade` takes a transaction-scoped advisory lock per (portfolio, symbol). It inserts the transaction, its fee lines and the cash movement, then replays the symbol's whole ledger through `finance-core` and rewrites the holding, the lots and each transaction's cost-basis audit columns. Back-dated postings and corrections are exact, and projection drift is impossible. Overselling surfaces as 409 `INSUFFICIENT_HOLDINGS`. Reversed transactions and their reversals are both excluded from the replay.
- **Risk evaluation is serialised per portfolio** (advisory lock) and **re-run at approval** with fresh state, so daily limits can't be raced past by concurrent approvals.
- **Approval** requires step-up, must match the stored **preview hash**, and must happen within 5 minutes; otherwise the order becomes EXPIRED. Every state change is an optimistic `updateMany(where status = expected)` plus an append-only `order_events` row.
- **Live path today = MANUAL_TICKET.** The CAPABILITY risk rule passes for it because a human placing the order personally is always permitted. Any automated adapter path must additionally pass `broker-sdk` `guardedCall()`. The **kill switch (default OFF) still blocks live previews and approvals.** Live orders refuse SIMULATED and stale (> 15 min) prices and outside PSX hours.
- **Recording a fill implies placement:** an explicit `PLACED_BY_USER` event ("implied by recorded fill") is logged, so the audit trail stays complete without an extra click. Fills are USER_REPORTED with ESTIMATED fees until a contract note reconciles them.
- **Paper trading** fills immediately against the latest quote with 5 bps slippage (`paperFill`) and **may run outside PSX hours**, because it's a simulation and is labelled SIMULATED. Non-marketable paper limit orders stay ACCEPTED (working). The working-order matcher is part of Phase 9.
- `orders.createdAt` comes from the injected clock (same source as the daily-limit window).
- **Verified end-to-end:** the docs/06 §3 worked example runs through HTTP → risk → approval → manual fills → ledger → PostgreSQL and reproduces exactly (`test/trading.int.test.ts`).

## ADR-022 · Statement import pipeline (Phase 5)

- **Flow:** upload (JSON file text, ≤ 2 MB) → SHA-256 file dedupe → parser registry → per-row validation → `imported_rows` (AWAITING_REVIEW) → review (skip / include) → **commit in ONE DB transaction** through `LedgerService.postTrade`.
- **Duplicate files:** a SHA-256 pre-check plus the `(brokerAccountId, fileSha256)` unique constraint. A concurrent identical upload that loses the race gets the same 409, with `existingImportId`.
- **Duplicate trades:** a row is flagged DUPLICATE (skipped by default; the owner may include it) when it matches:
  - an already **committed** imported row (fingerprint = sha256 of portfolio|date|symbol|side|qty|price, decimals normalised), or
  - an existing ledger transaction with the same economics or the same contract reference. This covers fills recorded by hand in the order pipeline.

  Identical rows _within_ one file stay VALID with a warning, because two separate fills at the same price are legitimate.

- **Invalid rows block the commit** until they are explicitly skipped. Nothing is ever dropped silently. INVALID rows can't be "included".
- **Fees:** charges stated in the file keep the parser's provenance (generic CSV → USER_REPORTED). Missing charges are computed by the fee engine and stored as **ESTIMATED** fee lines. The accounting methodology is unchanged.
- **Performance:** `postTrade(…, { rebuild: false })` for each row, then **one** `rebuildSymbol` per affected symbol inside the same transaction: O(n) instead of O(n²), with identical results. `rebuildSymbol` takes the per-symbol advisory lock itself (Postgres xact locks are re-entrant).
- **Atomicity:** an oversell or constraint failure on any row aborts the whole commit. The error names the source row (`rowNo`, via the ledger error's `eventId` → transaction → row map), and the import stays AWAITING_REVIEW so it can be fixed. Commit transaction timeout is 120 s.
- **Schema:** `imported_statements.portfolioId` (nullable FK, migration 3) records the target portfolio. It's additive and changes no accounting.
- **Errors:** the RFC 9457 filter now passes through an **allow-list** of extension members (`rowNo`, `existingImportId`). Internal fields such as `eventId` never leave the API.
- **Body limit:** the JSON parser limit is raised to 3 MB in `configureApp`. Verified on the compiled build: 2.5 MB is parsed, 4 MB gets 413.
- **Broker accounts:** `POST /broker/accounts` creates the KTrade account anchor, its LIVE portfolio (conservative limits, market orders off) and connection rows: MANUAL_IMPORT CONNECTED; KTRADE_OFFICIAL_API DISABLED; KTRADE_BROWSER PENDING_AUTHORIZATION. All capabilities are off and no credentials are accepted.
- **Frontend:** the web `ApiClient` import contract now mirrors the API. The demo client enforces the same rules, so demo and real behaviour don't diverge. The KTrade integration page shows connections plus the full import review UI.
- **Fix:** the demo kill switch defaulted to ON, contradicting the real default (OFF). Corrected, and tests updated to enable live trading explicitly.

## ADR-023 · Market-data review and reference-data seed (Phase 7, part 1)

- **Review of the agent-written market-data code: accepted.**
  - Prices use finance-core decimals.
  - The PRNG is SHA-256 in counter mode (reproducible on every platform, no float involvement). `Math.*` appears only on timestamps and indices.
  - It respects the PSX 0.01 tick and the trading calendar.
  - No scraping, no network access. The Capital Stake adapter is an honest disabled stub (no guessed endpoints).
- **`pnpm --filter @ktrade/api db:seed`** (idempotent):
  - 30 PSX stocks with their SIMULATED D1 history (2 years by default, `--years N`);
  - KTrade's published fee schedule as an effective-dated `fee_schedules` row.

  A re-run inserts nothing. Simulated bars **never overwrite** non-simulated rows (`overwritableProviderKeys`). The `stock_prices_ohlc_valid` CHECK constraint validated every generated bar (15,660 in dev).

- **Tax rates are NOT seeded.** This supersedes the "placeholders `verified=false`" wording in docs/05/06/09. Invented numbers, even flagged, could reach a calculation. The tax lookup fails loudly ("not configured") until the owner enters confirmed rates.
- **Pinned equivalence:** the DB-stored fee schedule must compute exactly the same fees as `ktradeDefaultSchedule()` (`test/seed.int.test.ts`), because FeeService prefers the DB schedule once seeded.
- **Lesson repeated** (cf. ADR-019): scripts must not import modules that load Nest `ConfigModule` (it validates the full API env at import). Constants used by scripts live in dependency-free modules (`ledger/fee-defaults.ts`, `auth/password-policy.ts`).

## ADR-024 · Market-data API, quote persistence and watchlists (Phase 7, part 2)

- **Quotes are persisted to `stock_quotes`** by `MarketDataService.refreshQuotes()`. **Defect fixed:** the order pipeline prices previews from `stock_quotes`, but nothing in production wrote that table (only tests did), so real paper-order previews would have failed with `NO_PRICE`. Refresh is lazy on read (throttled to 10 s, concurrent callers share one run). Optionally there's a background ticker every 15 s (`MARKET_DATA_TICKER=true`). A single instance needs no Redis cache, which keeps things simple.
- **"Real beats simulated":** when the active provider is SIMULATED but a symbol has non-simulated data (imported EOD CSV), that quote is used and flagged `stale` if old. Real but stale is more honest than fabricated but fresh. Every quote carries `source`, `providerKey`, `asOf`, `delayMinutes` and `stale`.
- **Candles:** D1 comes from `stock_prices`, with **per-bar `source`** (a series can mix imported and simulated days) plus the weakest-source summary. Intraday comes from the active provider when it has that capability. Range is validated, capped at 2,000 bars, and defaults to 6 months (D1) or 5 days (intraday).
- **Endpoints:** `/market/overview` (session state, breadth, top movers, sectors, data source, asOf), `/market/stocks` (search, sector, pagination), `/market/stocks/:symbol` (quote, 52-week high/low, 20-day average volume, history provenance), `/market/sectors`, `/market/quotes`, `/market/candles/:symbol`, `/market/movers`, `/market/providers` and `PUT …/active` (🔐, only enabled providers), and `POST /market/prices/import` (OWNER).
- **Watchlists:** per user, ≤ 20 lists of ≤ 100 stocks. Unique name per user (409). Adding a symbol is idempotent; unknown symbols get 404. Other users' lists return **404, not 403**, so ids aren't disclosed. Items cascade on delete.
- **Defect fixed (Zod 4 semantics):** refinements keep running after a failed check, so a refinement calling `d(v)` on malformed input threw and turned a 422 into a 500. This affected the agent-written EOD CSV parser (empty price field) and the portfolio `pctString`. Both are now guarded, with regression tests (`src/common/zod-refinements.test.ts`). **Rule:** every refinement that parses a decimal must first check `DECIMAL_STRING_RE`.
- **Licensed vendor:** Capital Stake stays registered but disabled. Activating it returns 409 `PROVIDER_UNAVAILABLE` until a licence, a key and official API docs exist.

## ADR-025 · Strategies, signals and backtesting API (Phase 9, backend)

- **Endpoints:**
  - `/strategies/templates`;
  - strategies CRUD (owner-scoped, unique names, no delete while active);
  - `activate` / `deactivate`;
  - `/strategies/validate` (dry run with explanation traces, saves nothing);
  - `/strategies/:id/evaluate`, signals and execution logs;
  - `/backtests` (+ `/compare`, `/:id`, `/:id/trades`).

  Every backtest response carries the disclaimer.

- **Mode comes from the portfolio** (PAPER or LIVE), never from the client. Built-in templates are recompiled from type + parameters on load, and editing the definition bumps `version`.
- **Live safety:**
  - `autoExecute` is refused for LIVE strategies (422 `LIVE_AUTO_EXECUTION_FORBIDDEN`) on create, edit and activation.
  - LIVE evaluation only records a signal. It never previews or approves an order.
- **System approval is PAPER-only.** `TradingService.approveSystemPaper` reuses the normal approval path (preview-hash binding, expiry, full risk re-check). Inside the locked transaction, it refuses with 403 `SYSTEM_APPROVAL_FORBIDDEN` unless order mode, portfolio kind and origin are PAPER, PAPER and STRATEGY. Events and audit rows carry actor `STRATEGY`. Covered by tests for LIVE and MANUAL refusal.
- **Deviation (accepted):** LIVE activation requires step-up, checked in the controller with the same `TokenService.verifyStepUp` the guard uses, and re-checked in the service. The static `@RequireStepUp()` would also force step-up on PAPER activation, which docs/07 does not require.
- **Backtests:**
  - Synchronous, ≤ 10 years and ≤ 5,000 bars.
  - **Costs come from the real KTrade fee engine** (the schedule in effect at `to`).
  - `dataSource` is the weakest bar source, so results on simulated prices are labelled SIMULATED.
  - Metrics too large for NUMERIC(12,6) are stored as null, with the full value in `params.metrics`. An open position at the end is saved as a trade without an exit.
  - New finance-core metrics: Sortino (downside vs the per-bar risk-free rate), annualised return, and risk/reward. Decimal-only, with hand-computed tests.
- **Not yet built:** `signals/:id/prepare-order | dismiss`, the scheduled evaluation (BullMQ), walk-forward splits and the shadow "mirror" mode.

## ADR-026 · Web ↔ API integration through a BFF (frontend)

- **The browser only calls `/bff/*`** (Next.js route handlers). Access token: `ktrade_at` (httpOnly, SameSite=Strict, Path=/bff, Max-Age = token TTL). Refresh token: `ktrade_rt`, taken from the API's Set-Cookie (httpOnly, Strict, **Path=/bff**). Both are Secure in production. **No token ever appears in a response body.** Step-up tokens are returned to the client and kept **in memory only**.
- **CSRF:** a double-submit `ktrade_csrf` cookie must match the `x-csrf-token` header, compared in constant time, plus a same-origin `Origin` check. It's required on every non-GET request, login and register included. The cookie is issued by `/bff/auth/me` and by `proxy.ts` when the login and register pages load.
- **Catch-all proxy:** forwards an allow-list of headers; never forwards the API's Set-Cookie; refuses token-issuing `/auth/*` routes (only `sessions`, `2fa` and `password` pass) and path traversal; JSON only (415) up to 3 MB (413); problem+json passes through unchanged. **On a 401 it refreshes once** (concurrent refreshes with the same token share one call, because the API revokes the whole session on refresh-token reuse), then retries. If the refresh fails, the cookies are cleared and it returns 401.
- **`NEXT_PUBLIC_DATA_MODE=api|demo`** (default `demo`). In api mode, features without a backend throw `NOT_AVAILABLE` and show a "not available yet" state. **Demo data is never mixed into the real UI.** Unauthenticated users are redirected to `/login`.
- **Pages on real data:** login (TOTP when required), register, market overview, stock explorer, stock details (candles with per-bar source, add to watchlist), watchlists, and the KTrade integration page (account registration and imports). Every price shows provenance, as-of time and a visible stale marker.
- **Deviations accepted:**
  1. Refresh-cookie Path=/bff (the narrower `/bff/auth` would never reach the catch-all's refresh).
  2. `BFF_COOKIE_SECURE=false` opt-out for plain-http local smoke tests.
  3. `/` redirects to `/market/overview` until the dashboard page exists.
  4. 15 s polling for quotes until a realtime gateway exists.
- **Verified:** a live smoke test against a throwaway PostgreSQL through the BFF: register, me, market overview, watchlist, forced refresh, logout, with no token in any body.
- **Test robustness:** Testing Library async queries now get 5 s (default 1 s). One page test timed out once while the full pipeline saturated the CPU. No assertion was changed.
- **Known gaps:** the step-up dialog only accepts a TOTP code (password step-up is supported by the client but not by the dialog yet); transaction filters are client-side over the newest 200 rows.

## ADR-027 · Portfolio snapshots, performance, alerts and notifications (Phase 10, backend)

- **Snapshots** value a portfolio at the close of a PSX trading day:
  - holdings are **replayed with LedgerService's own row → event mapping** (now a public method; an agent's private-member cast was replaced), so snapshots and projections can't disagree;
  - prices are the D1 close on or before the date. A holding with no close is valued at cost, labelled ESTIMATED and listed in `unpricedSymbols`;
  - cash, contributions, realized, dividends, fees and taxes are cumulative to that date.

  Upserts are idempotent. Backfill runs from first activity to the last completed session. There's an optional `SNAPSHOT_SCHEDULER` (after 16:00 PKT on trading days).

- **Flows and TWR:** only deposits and withdrawals are external flows (dividends, fees and adjustments are P&L), taken at end of day. TWR starts at the first snapshot with value above 0. Max drawdown is measured on the TWR index. Simple return and XIRR are since inception (XIRR is null when not computable). Every figure carries the weakest price source.
- **Summary labels:** `todayPnl.basis` is `SNAPSHOT` after the close, otherwise `LIVE_VS_PREVIOUS_SNAPSHOT` (live quotes vs the last close, minus flows). `monthPnl.basis` is `SNAPSHOTS` or `SNAPSHOTS_PLUS_LIVE_TODAY`. Each carries its dates and source. Plus `twrPct`.
- **Alerts:** typed params per alert type (decimal-guarded per ADR-024). A cooldown re-fires while the condition holds; `triggerOnce` deactivates after firing. **No double-firing:** a conditional claim update plus a per-cooldown-window notification dedupe key, in one transaction. `ALERTS_SCHEDULER` runs every 60 s while the market is open, or `POST /alerts/evaluate` runs it manually.
- **Notifications:** an in-app inbox (unread count, read, read-all; viewers can mark their own). Order FILLED and REJECTED_BY_RISK, and strategy signals, notify inside the originating transaction. **EMAIL and TELEGRAM are disabled adapters**: rows are written as FAILED "channel not configured" and **nothing is ever sent externally** until the owner configures channels (USER_ACTION #6).
- **Known gaps (tracked in TODO):**
  - the risk engine's DAILY_LOSS rule still receives `todayPnlPct = 0` (now wireable from snapshots; a deliberate separate change because it alters risk behaviour);
  - the summary's `accountValue` excludes unquoted holdings while snapshots value them at cost.

## ADR-028 · Daily-loss risk rule armed from real P&L

- **Defect fixed:** the risk engine's DAILY_LOSS rule always received `todayPnlPct = 0`, so the configured daily-loss limit (`maxDailyLossPct`) could never block anything.
- **Now:** `TradingService` passes the **same today's P&L the dashboard shows** (`PerformanceService.today`: the snapshot after the close, otherwise live quotes vs the previous close, net of deposits and withdrawals), in percent per the finance-core convention.
- **Semantics (finance-core):** only **BUYs** are blocked when today's loss exceeds the limit. **Sells are never blocked**, because reducing risk must stay possible.
- **Limitation (documented):** with no previous close snapshot there's no baseline, so the value is 0 and the rule can't block. Snapshots must exist: run the backfill or enable `SNAPSHOT_SCHEDULER`.
- Covered by `trading.int.test.ts` (BUY rejected at about −50 %, SELL allowed, dashboard basis matches).

## ADR-029 · Core web pages on the real API + two API fixes

- **Pages** (demo and api mode):
  - dashboard (12 KPI tiles with provenance, allocation, recent orders, portfolio switcher, "new paper portfolio");
  - holdings; transactions (cursor paging, fee lines with provenance);
  - **buy/sell**: Zod ticket, one Idempotency-Key per submission, preview with estimated fees, every risk check, price provenance and an expiry countdown, step-up approval. Paper shows the simulated result; live shows the manual KTrade ticket ("I placed it", "Record fill");
  - orders (detail drawer: risk checks, timeline, fills; cancel wording explains KTrade);
  - strategies (template forms, LIVE activation with step-up, auto-execute never offered for LIVE, dry run, evaluate, signals);
  - backtests (metrics, equity/drawdown, trades, compare; **the disclaimer is always visible and SIMULATED gets a prominent banner**);
  - a settings kill-switch toggle (step-up).
- **Step-up** accepts a password when TOTP isn't enabled. **Tokens and passwords stay in memory only** (verified: no browser-storage writes besides shadcn's sidebar UI-state cookie). `/` → `/dashboard`.
- **API fix:** a duplicate portfolio name returned 500 (unhandled P2002). It now returns 409 `ALREADY_EXISTS`.
- **API fix:** a paper preview could fail with `NO_PRICE` on a cold start, because quotes refresh lazily. `TradingService.preview` now refreshes quotes once when a symbol has none (TradingModule imports MarketDataModule; no cycle). Both have a regression test.
- **Remaining web gaps (TODO):** the dashboard performance chart isn't wired to `GET /portfolios/:id/performance` yet; there's no notifications or alerts UI; custom-rules strategies are view-only; dividends, analytics and reports have no backend yet.

## ADR-030 · Signal actions and strategy scheduler

- **`POST /signals/:id/prepare-order`** turns a NEW signal into an order **preview only** (origin STRATEGY). It **never approves** (verified: no approval call on that path). The owner approves with step-up as usual; LIVE becomes the manual KTrade ticket. Idempotency key `strategy-signal-<id>` is shared with the paper auto-execute path, so a signal can never produce two orders, even under concurrent requests. PAPER uses MARKET; LIVE uses LIMIT at the signal price (live portfolios refuse market orders by default). A risk rejection marks the signal `BLOCKED_BY_RISK`.
- **`POST /signals/:id/dismiss`**: NEW → DISMISSED. A NEW D1 signal **expires** at the close of the next trading session after its bar (holiday-aware); acting on it then returns 409.
- **`STRATEGY_SCHEDULER`** (default off) checks every 5 min on trading days at or after 15:35 PKT and evaluates each active D1 strategy once per completed bar through the existing `evaluate` path (audit actor SYSTEM).
  - **Concurrency:** no overlapping ticks in-process. A bar counts as done when a successful run log exists; this is checked before and after a per strategy+bar Postgres **try**-lock (skip, never wait). The signal unique key and order idempotency key are the backstop. A bar isn't retried after 3 failures.
  - LIVE strategies only record signals and notifications, **never orders**. PAPER + autoExecute behaves as before (system paper approval, PAPER-only).
- **Not yet:** intraday strategies aren't scheduled.
