# Architecture (entry point)

The full architecture lives in [`docs/02-architecture-plan.md`](docs/02-architecture-plan.md). Decisions and their reasons are in [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md).

## At a glance

```
Browser ── Next.js web (apps/web) ──[BFF, planned]── NestJS API (apps/api) ── PostgreSQL 16
                                                         │                 └─ Valkey 8 (cache/queues)
                                                         ├─ finance-core (pure decimal domain logic)
                                                         ├─ broker-sdk (adapters behind a capability chain)
                                                         └─ market-data providers (simulated | CSV EOD | licensed vendor: disabled)
```

## API modules (apps/api/src)

| Module                                               | Responsibility                                                                | Status |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| auth, audit, security                                | Login, sessions, 2FA, step-up, RBAC, append-only audit                        | ✅     |
| ledger, portfolio                                    | The only writer of trades (lock + replay), holdings, cash, dashboard          | ✅     |
| trading                                              | Preview → risk → approval → paper fill / manual live ticket, kill switch      | ✅     |
| imports, broker                                      | Statement import pipeline, KTrade account registration                        | ✅     |
| market-data                                          | Providers, quotes (persisted), candles, overview, sectors, movers, watchlists | ✅     |
| strategies, backtests, signals                       | Uses finance-core engines                                                     | ⏳     |
| notifications, alerts, dividends, analytics, reports |                                                                               | ⏳     |
| research, AI assistant                               | Attributable research and recommendations                                     | ⏳     |

## Data provenance

Every financial value carries a `DataSource`: BROKER_CONFIRMED > BROKER_DISPLAYED > PROVIDER > USER_REPORTED > ESTIMATED > SIMULATED. Aggregates report their weakest input.
