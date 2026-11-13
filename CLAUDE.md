# Project instructions (for Claude and human contributors)

Personal smart-trading platform for ONE KTrade (PSX) account. It handles real money, so correctness and safety beat speed.

## Resuming work (read first)
1. Read `DEVELOPMENT_STATUS.md` (stopping point, health, blockers) and `TODO.md` (first unchecked item = next task).
2. Verify the real codebase before trusting the notes: `pnpm db:up`, `pnpm turbo run build typecheck lint test`, and (with Docker) `cd apps/api && RUN_INTEGRATION=1 pnpm test`. Fix anything red before new work.
3. Never redo `[x]` items. Code marked "partial, from a stopped agent" must be reviewed before you build on it.
4. Before stopping, update both files so the next session can resume cleanly.

## Non-negotiables
- **Never** automate KTrade login, OTP, CAPTCHA or orders, or scrape PSX or KTrade sites. Both KTrade adapters stay disabled until KTrade gives written permission (docs/03). Every broker call goes through `guardedCall()` (packages/broker-sdk).
- **Never** use JS floats for money, price, qty or rates. Use `d()` and the helpers in `@ktrade/finance-core`. Values cross boundaries as decimal strings; the DB uses NUMERIC.
- Every financial figure carries a provenance `source` (DataSource enum). Never present SIMULATED or ESTIMATED values as confirmed. Never mark an order as executed without a recorded fill.
- No secrets in code, logs, chat or git. KTrade/PSX credentials are never stored anywhere.
- Live trading defaults: kill switch OFF, manual approval, AI can never place or approve orders.

## Layout
`apps/api` (NestJS 12, ESM, Prisma 7) · `apps/web` (Next 16; read `apps/web/AGENTS.md` and `node_modules/next/dist/docs` before Next-specific code) · `packages/finance-core` (pure decimal domain logic) · `packages/shared` (enums + Zod schemas; must match the Prisma enums, which the enum-sync test checks) · `packages/broker-sdk` (adapter and capability model) · `infra/` · `docs/` (specs 01–09) · `ARCHITECTURE_DECISIONS.md` (add an ADR for every notable decision).

## Commands (repo root; pnpm via corepack)
- `pnpm db:up` / `pnpm db:down`: Postgres 16 + Valkey 8 on 127.0.0.1
- `pnpm build | typecheck | lint | test`: the whole pipeline via turbo
- API: `cd apps/api && pnpm exec prisma generate` (after schema edits), new migration: `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new `prisma/migrations/<ts>_<name>/migration.sql`, then `pnpm db:deploy`
- Always smoke-test the **compiled** API (`node dist/main.js`) after build-config changes. Vitest can hide ESM resolution bugs (ADR-005).

## Conventions
- ESM everywhere; relative imports use `.js` suffixes in TS sources.
- Tests colocated as `*.test.ts`. API real-DB tests are `*.int.test.ts` (`RUN_INTEGRATION=1`).
- Fix root causes; never disable lint rules, skip tests or weaken validation to get green.
- Dependencies: add only with a clear benefit; pnpm's 7-day `minimumReleaseAge` applies (ADR-002).
