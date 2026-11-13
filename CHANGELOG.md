# Changelog

All notable changes. Dates are 2026 (PKT). Commit ids are on `main`.

## Unreleased

### Added

- Market-data API: overview (session, breadth, movers, sectors), stock search/explorer, stock details (52-week range, average volume, history provenance), quotes, candles (daily per-bar provenance, intraday), movers, sectors, provider listing and switching (🔐), and EOD price import.
- Watchlists: create, rename, delete, add and remove stocks, with quotes, per-user isolation and limits.
- Quote persistence to `stock_quotes`, plus an optional background ticker (`MARKET_DATA_TICKER`).
- Market-data unit tests (calendar, simulated provider, CSV parser, staleness, movers, vendor stub) and a PostgreSQL integration suite.
- Project documents: USER_ACTION_REQUIRED, CHANGELOG, TEST_REPORT, SECURITY_REPORT, ARCHITECTURE, DEPLOYMENT_GUIDE.

### Fixed

- Paper-order previews in the real app had no price source: nothing wrote `stock_quotes` outside tests.
- A validation error became a 500 when a Zod 4 refinement parsed malformed decimals (EOD CSV parser, portfolio risk-limit percentages).

## a612853 (2026-11-14): Market data, part 1

- Reviewed and accepted the agent-written market-data module; added the idempotent `pnpm db:seed` (stocks, simulated history, KTrade fee schedule; no unverified tax rates).

## d961174 (2026-11-14): Formatting

- Prettier applied repo-wide (no behaviour change).

## 317c3c3 (2026-11-14): Statement import pipeline

- CSV import with duplicate file and trade detection, a review workflow, atomic ledger commit, estimated-fee labelling, broker account registration and the frontend review UI.

## 9012930 / 7c4047d (2026-11-13): Foundation

- Research and design docs, the monorepo, finance-core, auth and security, the ledger, the portfolio and order pipeline, and the web scaffold.
