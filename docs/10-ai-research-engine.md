# 10 — AI Research & Recommendation Engine (design)

_Status: design, 2026-11-14. Build order and status: TODO.md. Principle: **every claim is attributable and dated, and nothing is invented.**_

## 1. Authorized data sources (researched 2026-11-14)

| Need                                           | Source                                                                                                                                                                                       | Access                               | Status                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| Prices, volumes, technicals                    | Active market-data provider (docs/09): SIMULATED, imported EOD CSV, or licensed vendor                                                                                                       | built                                | ✅ (simulated / imported) |
| Macro: policy rate, CPI inflation, PKR FX      | **SBP EasyData** (State Bank of Pakistan, official). Public datasets; the API needs a free sign-in                                                                                           | API key from the owner's SBP account | ⛔ USER_ACTION #8         |
| Company fundamentals (statements, EPS, ratios) | **Capital Stake** (authorized PSX vendor: standardised financials, valuation ratios, ownership) or **EODHD** (PSX `.KAR` fundamentals in its plans)                                          | paid licence                         | ⛔ USER_ACTION #3         |
| Filings / announcements                        | Licensed vendor (Capital Stake / FinancialReports API). PSX's portal terms forbid commercial or derived use without PSX approval (contact: marketdatarequest@psx.com.pk), so **no scraping** | paid licence or PSX approval         | ⛔                        |
| Company annual and quarterly reports           | Published by the companies themselves; **you upload** the PDF or enter key figures                                                                                                           | manual                               | ✅ planned                |
| Your portfolio                                 | Ledger, imports, orders                                                                                                                                                                      | built                                | ✅                        |

Until a licensed source is configured, fundamentals come from **owner-entered or uploaded figures** (labelled `USER_REPORTED`, with the document and page cited) and nothing else.

## 2. Architecture

```
ResearchProviders (interfaces, like MarketDataProvider)
  ├─ PriceHistory  → market-data service (exists)
  ├─ Fundamentals  → ManualFundamentalsProvider (owner-entered) | CapitalStakeFundamentals (disabled) | EodhdFundamentals (disabled)
  ├─ Macro         → SbpEasyDataProvider (needs key) | ManualMacroProvider
  └─ Announcements → (disabled until licensed)
        │  each datum: {value, unit, period, source, sourceUrl/document, publishedAt, retrievedAt}
        ▼
Analysis (finance-core, pure, deterministic, tested)
  ├─ technical: SMA/EMA/RSI/MACD/Bollinger (exist) + support/resistance, trend, breakout, volatility, volume analysis
  ├─ fundamental: growth (revenue/EPS), margins, P/E, P/B, ROE, ROA, D/E, FCF, dividend yield and history (only from supplied data)
  └─ portfolio: exposure by stock/sector, concentration, drawdown, P&L attribution
        ▼
Recommendation engine (deterministic scoring → BUY / SELL / HOLD / WATCHLIST / AVOID)
  ├─ evidence[]: every metric used, with value, period and source
  ├─ thesis, fundamental assessment, technical assessment, valuation, risks, downside, horizon
  ├─ confidence = f(data coverage, data freshness, signal agreement); capped LOW whenever inputs are SIMULATED or missing
  └─ invalidation conditions (e.g. "close below 52-week low", "EPS growth turns negative")
        ▼
LLM layer (optional, provider-abstracted, opt-in): writes the narrative ONLY from the evidence bundle;
  a post-check rejects any number in the text that is not in the bundle. It cannot create or approve orders.
```

## 3. Rules

- **No data, no claim.** A metric whose inputs are missing is reported as "not available", never estimated silently.
- **Simulated prices are never investment evidence.** A recommendation computed on SIMULATED prices is labelled "SIMULATED — for testing only", with confidence forced to LOW.
- Every recommendation stores: inputs snapshot, source list, `generatedAt`, data freshness, engine version. It's reproducible and auditable.
- Disclaimers: no guaranteed returns. These are research aids, not advice, and execution is always a separate, human-approved step.
- Recommendations never reach order execution except as a prefilled preview that the owner reviews and approves with step-up.

## 4. Reports

Daily, weekly and monthly reports, generated by scheduled jobs from the same evidence bundles: portfolio performance, exposure, risks, signals, watchlist changes and data-quality warnings. They're delivered in-app and by email once configured.
