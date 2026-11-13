# Phase 1 — KTrade Integration Feasibility Report

_Date: 2026-11-13 · Status: Research complete, pending confirmation from KTrade_

## 1. Executive summary

| Capability                          | Official, documented route exists?              | Decision                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trading API (place/cancel orders)   | **No**                                          | Live trading through the app is **disabled**. "Assisted trading": the app prepares and approves an order ticket, the user places it in the KTrade app, and the fill is recorded or reconciled. |
| Account/portfolio/cash/holdings API | **No**                                          | Read-only data comes from **statement and CSV import** plus manual entry.                                                                                                                      |
| Order history/transactions API      | **No**                                          | Import from broker statements or CSV.                                                                                                                                                          |
| Market data (PSX)                   | **Yes, through a licensed vendor** (not KTrade) | `MarketDataProvider` abstraction. Default to manual or EOD CSV; Capital Stake (an authorized PSX feed vendor) is an optional licensed adapter.                                                 |
| Dividends / corporate actions       | Vendor data (licensed), plus broker statements  | Manual entry, statement import, and an optional licensed vendor feed.                                                                                                                          |
| Rate limits                         | N/A (no API)                                    | Rate limits are defined per provider adapter.                                                                                                                                                  |

**Conclusion:** A full read/write KTrade integration is **not feasible today through authorized means**. The platform will be built on a `BrokerAdapter` abstraction. Today it ships with an import-based (read-only) adapter and a paper-trading adapter. A `KTradeOfficialAdapter` stub stays disabled and throws `BrokerCapabilityUnavailable` until KTrade gives written API access.

## 2. Findings

### 2.1 KTrade (KTrade Securities / KASB)

- KTrade's official pages list: virtual trading (demo with PKR 1M), real trading, Shariah stocks, watchlists, 24/7 portfolio tracking, a research portal, trader's assistance, and Android, iOS, desktop and web terminals. **They mention no API, developer portal or third-party integration.** ([kasb.com/invest-in-stocks](https://kasb.com/invest-in-stocks/))
- KTrade launched a new online trading app in Oct 2026 ([ProPakistani](https://propakistani.pk/2026/10/07/simplifying-psx-account-opening-ktrade-launches-new-online-trading-app/)). Its embedded trading in JazzCash ([ProPakistani](https://propakistani.pk/2025/10/20/ktrade-introduces-pakistans-largest-embedded-trading-platform-for-20m-jazzcash-users/amp/)) is a B2B partnership, not a public API.
- A third party, **StockIntel**, says it offers a PSX trading API and lists KTrade as a supported broker. Its own broker directory shows KTrade as **"In Progress"** ([stockintel.com/platforms/psx-trading-api](https://stockintel.com/platforms/psx-trading-api), [stockintel.com/psx-brokers](https://stockintel.com/psx-brokers)). This is **unverified marketing**. It is not KTrade documentation, so we do not build on it. It is a candidate for a future adapter **only if** KTrade confirms in writing that the integration is authorized for your account.
- Order types are **not documented officially**. Third-party blogs disagree (market/limit/stop). The app will treat order types as an **adapter capability**. Only `MARKET` and `LIMIT` are modelled until they are confirmed.
- Statements: blogs mention e-statements, but no official export format is documented. **We need a sample statement from you** (PDF or CSV/XLSX, with personal data redacted) to build the parser.

### 2.2 PSX market data

- PSX has **no public developer API**. Community libraries and "free APIs" scrape `dps.psx.com.pk`, so they are **excluded** under the project rules ([psxdata docs](https://psxdata.readthedocs.io/en/latest/guides/free-psx-api/), [parse.bot listing](https://www.parse.bot/marketplace/2d5c196e-712b-409e-b00d-dfd2ec453b44/dps-psx-com-pk-api)).
- **Capital Stake** calls itself an _Authorized PSX Feed vendor_. Its documentation covers quotes, intraday bars (1/5/15 min), EOD (adjusted and unadjusted), market summary, and corporate actions (dividends, bonus, rights, splits), plus a WebSocket live feed ([REST docs](https://www.capitalstake.com/docs/rest/api/stocks/intro), [WebSocket docs](https://capitalstake.com/docs/websocket/intro), [data solutions](https://www.capitalstake.com/data-solutions)). Authentication, pricing and rate limits are **not public**, so they need a commercial agreement.
- PSX sells an EOD data product with Deutsche Börse on a subscription basis ([ProPakistani](https://propakistani.pk/2025/09/26/psx-launches-end-of-day-product-in-collaboration-with-deutsche-borse-ag/amp/)) and sells historical data ([psx.com.pk services](https://www.psx.com.pk/psx/product-and-services/services)).

### 2.3 Security constraints (non-negotiable)

- We will not automate a browser against KTrade's web or app, will not reverse-engineer its private endpoints, and will not bypass OTP, MFA or CAPTCHA.
- **KTrade passwords are never stored.** No adapter needs them today. A future official adapter will store only OAuth/API tokens, encrypted at rest (AES-256-GCM, envelope key from the environment or KMS), and never send them to the frontend.

## 3. Resulting integration design

```
BrokerAdapter (interface, capability-flagged)
├── ManualImportBrokerAdapter   ✅ read-only: CSV/XLSX/PDF statement import, manual entries
├── PaperBrokerAdapter          ✅ simulated fills against provider prices (no real money)
├── KTradeOfficialAdapter       ⛔ stub; every method throws BrokerCapabilityUnavailable
│                                  until official API docs + written authorization exist
└── KTradeBrowserAdapter        ⛔ designed (doc 03 §5), all capabilities false until KTrade
                                   grants written permission per capability

MarketDataProvider (interface)
├── ManualCsvProvider           ✅ EOD/historical CSV upload (user-licensed data)
├── CapitalStakeProvider        ⏸ implemented only after a contract + official API docs
└── PsxEodSubscriptionProvider  ⏸ same condition
```

The `capabilities` object (`placeOrder`, `cancelOrder`, `getHoldings`, `streamQuotes`, …) is checked by the UI and the services. The UI never offers an action the active adapter cannot perform. Every "live" path checks capabilities **and** the global kill switch.

**Assisted live-trading flow (works today and is safe):**
`Draft → Risk-checked preview → User approves (re-auth) → "Order ticket" shown → user places it in the KTrade app → user marks it placed and enters the fill → reconciled against the next statement import.`
The system never shows an order as _executed_ until a fill is entered by the user or imported from a statement. Each step is labelled `USER_REPORTED` or `BROKER_CONFIRMED`.

## 4. Data accuracy labels

Every financial figure carries a `source`:

- `BROKER_CONFIRMED`: from an imported broker or CDC statement
- `USER_REPORTED`: manual entry
- `ESTIMATED`: computed with configured fee/tax tables or provider prices
- `SIMULATED`: paper trading or backtest

## 4a. Update 2026-11-13: browser automation investigated

See [03-browser-automation-investigation.md](03-browser-automation-investigation.md). Summary:

- The official web portal (`apps.ktrade.pk/webterminalv3`) has a second authentication factor ("Authentication 2" / "Generate"). It publishes **no terms of use and no automation policy**.
- KTrade's Online Trading Terminal Agreement and Customer Awareness Notification put strict non-disclosure duties on the PSX-issued password/PIN and place all online-trading risk on the account holder. **No document permits automated or programmatic use.**
- Decision: `KTradeBrowserAdapter` is **designed but disabled** pending written permission from KTrade compliance. A draft request is in doc 03 §6.
- New authorized data source: **electronic contract notes**, which KTrade must email by the next trading day (T&C §5(e)). These give broker-confirmed fills and become the primary reconciliation source.
- Published commission: **0.3% or Rs 0.06/share, whichever is higher; SST 15% on brokerage; CDC/NCCPL/CGT charges at actual.** These seed the default fee schedule.

## 5. Open items for you

1. **Ask KTrade support in writing** whether a retail or partner API exists, and whether the StockIntel integration is official and authorized for your account.
2. **Provide sample statements** (trade confirmation, ledger, holdings/CDC statement) as redacted files so the import parsers match the real formats.
3. **Market data choice:** manual EOD CSV (free, what we build first) or a licensed vendor (Capital Stake / PSX EOD, paid).
4. **Fee/tax tables:** commission rate, CDC, SECP, PSX levies, CVT, SST, CGT and dividend WHT change over time. They are stored as **effective-dated configuration**, not hardcoded, and you check the values against your contract notes.
