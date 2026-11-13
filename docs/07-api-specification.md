# 07 — API Specification (v1)

This is the contract. From Phase 3 on, the live OpenAPI 3.1 document is generated from code by `@nestjs/swagger` and served at `/api/docs` (JSON at `/api/docs-json`). A CI test fails if a route in this file is missing from the generated spec, or if the generated spec has a route that isn't listed here.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`. The browser talks only to the Next.js BFF (`/bff/*`), which attaches tokens server-side |
| Auth | `Authorization: Bearer <access JWT>` (BFF → API). Refresh uses an httpOnly cookie on `/api/v1/auth/refresh` |
| Roles | 🅾 = OWNER only, 🅥 = OWNER or VIEWER. 🔐 = step-up (TOTP) required, sent as `X-Step-Up-Token` |
| Money / qty / price | **JSON strings** (`"25086.2500"`), never numbers |
| Provenance | Every financial object carries `"source": "BROKER_CONFIRMED" \| "BROKER_DISPLAYED" \| "PROVIDER" \| "USER_REPORTED" \| "ESTIMATED" \| "SIMULATED"`; aggregates carry `sourceBreakdown` |
| Idempotency | `Idempotency-Key` header **required** on every POST that creates orders, fills, imports or cash movements |
| Pagination | Cursor: `?limit=50&cursor=…` → `{ data, nextCursor }`. Sorting via `?sort=-createdAt` |
| Filtering | `?symbol=OGDC&from=2026-01-01&to=2026-06-30&status=FILLED` |
| Errors | RFC 9457 `application/problem+json` with `{ type, title, status, detail, code, errors?[] }`. Domain codes such as `RISK_CHECK_FAILED`, `CAPABILITY_UNAVAILABLE`, `KILL_SWITCH_ON`, `PREVIEW_EXPIRED`, `PREVIEW_MISMATCH`, `STALE_PRICE`, `DUPLICATE_IMPORT` |
| Rate limits | `429` with `Retry-After`. Limits are listed in doc 04 |
| Time | ISO 8601 UTC instants; dates as `YYYY-MM-DD` in the PKT trading calendar |

## 2. Endpoints

### Auth & security
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/register` | public | Only enabled when no OWNER exists, or by invitation |
| POST | `/auth/login` | public | Returns access token plus a refresh cookie, or `{ totpRequired: true, challengeId }` |
| POST | `/auth/login/totp` | public | Completes the 2FA challenge |
| POST | `/auth/refresh` | cookie | Rotates the token; reuse revokes the family |
| POST | `/auth/logout` | 🅥 | |
| POST | `/auth/step-up` | 🅥 | TOTP → short-lived (5 min) step-up token |
| GET | `/auth/sessions` · DELETE `/auth/sessions/:id` · DELETE `/auth/sessions` | 🅥 | List and revoke sessions |
| POST | `/auth/2fa/setup` · `/auth/2fa/enable` · `/auth/2fa/disable` 🔐 | 🅥 | |
| PUT | `/auth/password` 🔐 | 🅥 | |

### Dashboard & portfolio
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/dashboard/summary?portfolioId=` | 🅥 | Account value, invested, cash (ledger and broker), realized, unrealized, today's and month's P&L, TWR/XIRR, dividends, fees & taxes, active holdings, pending orders, `sourceBreakdown`, `pricesAsOf` |
| GET | `/dashboard/charts?portfolioId=&range=1M\|3M\|YTD\|1Y\|ALL` | 🅥 | Performance series, allocation, daily P&L, monthly bars, stock distribution |
| GET | `/portfolios` · POST `/portfolios` (PAPER) · PATCH `/portfolios/:id` | 🅥 / 🅾 | |
| GET | `/portfolios/:id/holdings` | 🅥 | Symbol, name, qty, avgCost, last, totalCost, MV, unrealized, realized, weight, `lastConfirmed` |
| GET | `/portfolios/:id/holdings/:symbol` | 🅥 | Detail, lots, transactions, dividends |
| POST | `/portfolios/:id/replay` 🔐 | 🅾 | Rebuild projections from the ledger |
| GET | `/portfolios/:id/transactions` · POST (manual) · POST `/transactions/:id/reverse` | 🅥 / 🅾 | Corrections are reversals |
| GET/POST | `/portfolios/:id/cash-movements` | 🅥 / 🅾 | Deposits, withdrawals, adjustments |
| GET/POST | `/corporate-actions` · POST `/corporate-actions/:id/apply` | 🅥 / 🅾 | |

### Broker & sync
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/broker/accounts` · POST | 🅥 / 🅾 | POST `{ displayName, clientCodeLast4?, portfolioName? }` registers the KTrade account plus its LIVE portfolio (conservative risk limits, market orders off). No credentials are accepted. Adapters are created DISABLED. |
| GET | `/broker/accounts/:id/connections` | 🅥 | Adapters with their capability manifest (`implemented / verified / authorized / enabled`) |
| PATCH | `/broker/connections/:id/capabilities` 🔐 | 🅾 | Can only set `enabled`, and only where `implemented ∧ verified ∧ authorized`. `authorized` requires an `authorizationRef` |
| POST | `/broker/connections/:id/session/start` · `/session/destroy` | 🅾 | Browser adapter only (disabled). Returns `409 CAPABILITY_UNAVAILABLE` today |
| POST | `/imports` (JSON `{ portfolioId, fileName, content, kind? }`, content = file text, ≤ 2 MB) | 🅾 | Target must be a LIVE broker portfolio. Rows are staged as VALID / INVALID / DUPLICATE (`AWAITING_REVIEW`). Errors: `409 DUPLICATE_IMPORT` (+`existingImportId`), `422 UNSUPPORTED_FILE`, `PARSE_FAILED`, `EMPTY_FILE`, `IMPORT_REQUIRES_LIVE_PORTFOLIO`. Binary formats (PDF/XLSX) arrive with the KTrade parsers |
| GET | `/imports?portfolioId=` · `/imports/:id` · `/imports/:id/rows?status=` | 🅥 | Rows carry `errors[]`, `warnings[]`, `fees[]`, `feeSource` (`FILE` or `ESTIMATED_ON_COMMIT`) and `duplicateOf` |
| PATCH | `/imports/:id/rows/:rowId` `{ action: "skip" \| "include" }` | 🅾 | Include only overrides DUPLICATE; INVALID rows can only be skipped (`409 ROW_NOT_INCLUDABLE`) |
| POST | `/imports/:id/commit` · `/imports/:id/reject` | 🅾 | Commit is **all-or-nothing** in one DB transaction via LedgerService. `409 IMPORT_HAS_INVALID_ROWS` until invalid rows are skipped; `409 IMPORT_OVERSELL` / `IMPORT_ROW_REJECTED` with `rowNo` roll back everything |
| GET/POST/DELETE | `/sync/mailbox` (connect via OAuth, status, disconnect) | 🅾 | |
| GET | `/sync/discrepancies` | 🅥 | Holdings and cash mismatches |

### Orders & trading
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/orders/preview` | 🅾 | Body: `{ portfolioId, symbol, side, type, quantity, limitPrice?, stopPrice?, origin, signalId? }` → order in `PREVIEWED` or `REJECTED_BY_RISK`, with `riskChecks[]`, fee breakdown, `previewHash`, `previewExpiresAt`, `executionPath: "PAPER_AUTO" \| "MANUAL_TICKET" \| "ADAPTER"` |
| POST | `/orders/:id/approve` 🔐 | 🅾 | Body `{ previewHash }`. Re-runs risk checks. → `APPROVED` → `AWAITING_MANUAL_PLACEMENT` / `SUBMITTED` / paper fill |
| POST | `/orders/:id/mark-placed` | 🅾 | Manual path: you placed it in KTrade. Optional `brokerOrderRef` |
| POST | `/orders/:id/fills` | 🅾 | Manual fill entry (`USER_REPORTED`): `{ quantity, price, executedAt }` |
| POST | `/orders/:id/cancel` | 🅾 | Adapter cancel if capable; otherwise marks `CANCEL_REQUESTED` with a reminder to cancel in KTrade |
| GET | `/orders?status=&mode=&from=&to=` · `/orders/:id` (with events, riskChecks, executions) | 🅥 | |
| GET | `/executions` | 🅥 | Fills, including trades learned from contract notes |
| GET/PUT | `/portfolios/:id/risk-limits` (PUT 🔐) | 🅥 / 🅾 | |
| GET/PUT | `/admin/kill-switch` (PUT 🔐) | 🅥 / 🅾 | `{ liveTradingEnabled: boolean, reason }` |
| GET | `/fees/estimate?symbol=&side=&qty=&price=` | 🅥 | Fee-engine breakdown |
| GET/POST | `/fees/schedules` · `/tax-rates` | 🅥 / 🅾 | Effective-dated |

### Market data
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/market/providers` · PUT `/market/providers/active` 🔐 | 🅥 / 🅾 | Provider list, capabilities, health, delay |
| GET | `/market/stocks?search=&sector=` · `/market/stocks/:symbol` | 🅥 | |
| GET | `/market/quotes?symbols=OGDC,HUBC` | 🅥 | Each item has `asOf`, `delayMinutes`, `source`, `stale` |
| GET | `/market/candles/:symbol?interval=D1&from=&to=&adjusted=true` | 🅥 | |
| GET | `/market/movers?type=gainers\|losers\|active&limit=` | 🅥 | |
| POST | `/market/prices/import` (CSV) | 🅾 | `CsvEodProvider` |
| CRUD | `/watchlists`, `/watchlists/:id/stocks` | 🅥 / 🅾 | |

### Strategies, signals, backtests, paper
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/strategies/templates` | 🅥 | Built-ins with a parameter schema (JSON Schema for the UI form) |
| GET/POST/PATCH/DELETE | `/strategies` · `/strategies/:id` | 🅥 / 🅾 | Editing bumps `version` |
| POST | `/strategies/:id/activate` · `/deactivate` | 🅾 | Activating a LIVE strategy 🔐 |
| POST | `/strategies/validate` | 🅥 | Validate the rule DSL plus a dry run on the last N bars |
| GET | `/strategies/:id/signals` · `/signals?status=` · `/signals/:id` (with trace) | 🅥 | |
| POST | `/signals/:id/prepare-order` · `/signals/:id/dismiss` | 🅾 | |
| GET | `/strategies/:id/executions` | 🅥 | Evaluation run log |
| POST | `/backtests` | 🅾 | `{ strategyId \| inline definition, symbol, interval, from, to, initialCapital, slippageBps }` → queued |
| GET | `/backtests` · `/backtests/:id` · `/backtests/:id/trades` | 🅥 | Metrics, equity curve, benchmark, disclaimer |
| POST | `/paper/portfolios/:id/reset` 🔐 | 🅾 | |

### Alerts, notifications, dividends
| Method | Path | Role | Notes |
|---|---|---|---|
| CRUD | `/alerts` | 🅥 / 🅾 | Typed `params` per `AlertType` |
| GET | `/notifications?unread=true` · POST `/notifications/:id/read` · `/notifications/read-all` | 🅥 | |
| GET/PUT | `/notifications/channels/:channel` · POST `/notifications/channels/:channel/test` | 🅾 | Email (SMTP) and Telegram configuration |
| GET/POST | `/dividends` (declarations) · `/portfolios/:id/dividend-entitlements` | 🅥 / 🅾 | |
| POST | `/dividend-entitlements/:id/mark-paid` · `/reconcile` | 🅾 | |

### Analytics & reports
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/analytics/performance?portfolioId=&period=day\|week\|month\|year&from=&to=` | 🅥 | |
| GET | `/analytics/realized-unrealized` · `/analytics/stocks` · `/analytics/allocation?by=stock\|sector` · `/analytics/fees-taxes` · `/analytics/dividends` | 🅥 | Estimates and confirmed figures shown separately |
| POST | `/reports` | 🅥 | `{ type: "PERFORMANCE"\|"TRANSACTIONS"\|"HOLDINGS"\|"DIVIDENDS"\|"FEES_TAXES"\|"CGT_ESTIMATE", format: "PDF"\|"CSV"\|"XLSX", filters }` → job |
| GET | `/reports/:id` · `/reports/:id/download` | 🅥 | Short-lived signed download |

### AI assistant
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/assistant/conversations` · GET list · GET `/:id` | 🅥 | |
| POST | `/assistant/conversations/:id/messages` | 🅥 | **SSE stream** of text deltas, tool calls (name, args, data digest) and citations. Requires `aiDataSharingOptIn` |
| GET/PUT | `/assistant/settings` | 🅾 | Provider, model, opt-in |

Assistant tools (read-only):
- `get_portfolio_summary`, `get_holdings`, `get_transactions`
- `get_dividends`, `get_cash`, `get_quotes`, `get_candles`
- `simulate_price_shock(symbol, pct)`, `get_risk_metrics`
- `explain_signal(id)`
- `draft_order_suggestion`, which creates **nothing**: it returns a prefilled preview link that you must open and approve yourself

### Settings, audit, health
| Method | Path | Role |
|---|---|---|
| GET/PUT | `/settings/user` · `/settings/app` | 🅥 / 🅾 |
| GET/POST/DELETE | `/integrations/credentials` (metadata only; values write-only) 🔐 | 🅾 |
| POST | `/security/destroy-all` 🔐 | 🅾 |
| GET | `/audit-logs?action=&entityType=&from=&to=` | 🅾 |
| GET | `/health` · `/ready` | public (no details) |

## 3. Key payloads

**Order preview response:**
```json
{
  "id": "6f1c…", "status": "PREVIEWED", "mode": "LIVE", "executionPath": "MANUAL_TICKET",
  "symbol": "HUBC", "side": "BUY", "type": "LIMIT", "quantity": "100", "limitPrice": "150.00",
  "referencePrice": { "value": "149.80", "asOf": "2026-11-13T07:15:02Z", "source": "PROVIDER", "delayMinutes": 0 },
  "estimate": {
    "notional": "15000.0000",
    "fees": [ {"component":"COMMISSION","amount":"45.00","source":"ESTIMATED"},
              {"component":"SST_ON_COMMISSION","amount":"6.75","source":"ESTIMATED"},
              {"component":"CDC_CHARGES","amount":"0.00","source":"ESTIMATED","note":"at actual — known after contract note"} ],
    "total": "15051.7500"
  },
  "riskChecks": [ {"rule":"BUYING_POWER","passed":true,"observed":"120400.00","limit":"15051.75"}, "…" ],
  "previewHash": "sha256:…", "previewExpiresAt": "2026-11-13T07:20:02Z",
  "warnings": ["Live execution is manual: place this order in the KTrade app after approval."]
}
```

**Dashboard summary (excerpt):**
```json
{
  "accountValue": { "value": "1254300.5000", "sourceBreakdown": {"BROKER_CONFIRMED":"0.82","PROVIDER":"0.18"} },
  "cash": { "ledger": "120400.0000", "broker": { "value": "120400.0000", "asOf": "2026-11-12", "source": "BROKER_CONFIRMED" } },
  "unrealizedPnl": { "value": "54210.1200", "source": "ESTIMATED" },
  "pricesAsOf": "2026-11-13T07:15:02Z", "priceSource": "SIMULATED"
}
```

## 4. WebSocket (`/realtime`, Socket.IO, authenticated via the BFF)

| Event | Payload |
|---|---|
| `quote` | `{ symbol, last, change, changePct, volume, asOf, source, delayMinutes }`, for watched symbols only |
| `order.updated` | `{ orderId, status, filledQuantity, avgFillPrice, statusSource }` |
| `signal.created` | `{ signalId, strategyId, symbol, type, reason, price, score }` |
| `notification` | `{ id, title, body, data }` |
| `sync.completed` | `{ importId, committed, matched, discrepancies }` |
| `killswitch.changed` | `{ liveTradingEnabled }` |
| `broker.session` | `{ connectionId, status }`, for the browser adapter once enabled |
