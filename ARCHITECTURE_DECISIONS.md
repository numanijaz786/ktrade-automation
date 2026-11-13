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
