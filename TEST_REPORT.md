# Test Report

_Last full run: 2026-11-14, on Windows 11, Node 24.13, Docker Desktop (Testcontainers: PostgreSQL 16)._

## How to run

```bash
pnpm turbo run build typecheck lint test     # every package and app
pnpm format:check
cd apps/api && RUN_INTEGRATION=1 pnpm test   # + real-PostgreSQL suites (needs Docker)
```

## Results

| Area                          | Suite                                                                                                                                                                                            | Tests          | Result |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------ |
| finance-core                  | fees, ledger (WAC/FIFO, corporate actions, dividends), returns (TWR/XIRR/drawdown), indicators, strategy DSL, risk engine, backtester                                                            | 184            | ✅     |
| shared                        | enums, decimal-string schemas                                                                                                                                                                    | 13             | ✅     |
| broker-sdk                    | capability chain, guardedCall, disabled KTrade stubs                                                                                                                                             | 8              | ✅     |
| api: unit / e2e               | TOTP RFC 6238 vectors, envelope crypto, CSV parser, market data, Zod 4 guards, HTTP pipeline (rate limit, problem+json, headers), enum sync                                                      | 33             | ✅     |
| api: integration (PostgreSQL) | auth · trading (incl. DAILY_LOSS) · imports · seed · market data (incl. cold-start pricing) · strategies · snapshots and alerts                                                                  | 16 files       | ✅     |
| web                           | BFF security, HTTP client + mappers, pages (dashboard, holdings, transactions, order ticket + approval, orders, strategies, backtests, market, watchlists), step-up (password/TOTP), demo client | 117            | ✅     |
| build / typecheck / lint      | all workspaces                                                                                                                                                                                   | 20 turbo tasks | ✅     |
| format                        | Prettier                                                                                                                                                                                         | repo           | ✅     |

**API total: 136 tests in 18 files. finance-core 188. Web 145 in 17 files.**

## Key correctness evidence

- **Accounting:** the docs/06 worked example (buy 100 @ 250, buy 50 @ 270, sell 60 @ 280) reproduces **exactly** (realized 1288.9080, average cost 257.552200) through three independent paths: finance-core, the HTTP order pipeline, and CSV import.
- **Atomicity:** a failed import commit (oversell) leaves transactions, cash, holdings and import state byte-for-byte unchanged.
- **Security:** refresh-token reuse revokes the session; TOTP codes can't be replayed; step-up is required for sensitive routes; the audit log and order events are append-only (DB triggers).
- **Data provenance:** simulated data never overwrites imported real prices; imported real prices take priority over simulated quotes.

## Not yet covered

- Frontend pages beyond the KTrade integration page; end-to-end browser tests (Playwright).
- WebSocket, notification, strategy-scheduler and AI-assistant modules (not built yet).
