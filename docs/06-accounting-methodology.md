# 06 — Accounting Methodology

All formulas are implemented once, in `packages/finance-core`. The ledger, dashboard, paper broker and backtester all import them from there. The worked examples below become unit-test fixtures verbatim.

> Figures labelled `ESTIMATED` use the configured fee and tax tables. They are replaced by `BROKER_CONFIRMED` values when the contract note or statement is imported. **Tax rates in the seed data are placeholders marked `verified=false`.** Check them against FBR and NCCPL before relying on tax figures.

## 1. Numeric rules

- Arithmetic: `decimal.js` with precision 34. Never JS `number`.
- Fee components are rounded to **0.01 PKR** per component, `ROUND_HALF_UP` by default (configurable, to be confirmed against real contract notes). Reconciliation tolerance is **Rs 1.00** per contract-note line.
- Stored ledger amounts use 4 dp; per-share values use 6 dp.
- **`totalCost` is authoritative; `avgCost = totalCost / quantity` is derived.** Sells remove cost proportionally from `totalCost`. This prevents the rounding drift you get from multiplying a rounded average.

## 2. Fee model (KTrade published schedule, effective-dated)

| Component                             | Default rule                                                                               | Capitalised into cost?        | Source                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------- |
| Commission                            | `max(0.3% × value, Rs 0.06 × qty)` per side                                                | Yes                           | KTrade Commission Structure PDF |
| Day trade (same-day round trip)       | Commission on **one side only**                                                            | Yes                           | Same PDF                        |
| SST                                   | 15% × commission                                                                           | Yes                           | Same PDF                        |
| CDC / NCCPL / levies (SECP, PSX), CVT | `AT_ACTUAL`: estimate shown as 0 with a ⚠, filled in from the contract note                | Yes                           | Same PDF ("as per actual")      |
| CGT                                   | From `tax_rates` (filer status, holding period); usually collected by NCCPL, not per trade | **No.** Tracked as tax        | Placeholder, must be verified   |
| Dividend WHT                          | From `tax_rates` (filer status)                                                            | N/A (reduces dividend income) | Placeholder, must be verified   |

Buy fees are added to cost. Sell fees reduce proceeds. Taxes never change the cost basis.

## 3. Cost basis: weighted-average cost (default)

Per `(portfolio, symbol)`:

```
BUY  q at p, fees f:   totalCost += q·p + f ;  qty += q
SELL q at p, fees f:   costRemoved = totalCost × q / qty          (4 dp)
                       realized    = (q·p − f) − costRemoved
                       totalCost  -= costRemoved ;  qty -= q
                       if qty == 0 → totalCost = 0 (any residue goes to realized)
avgCost = totalCost / qty
```

**FIFO (optional per portfolio):** lots are always recorded in `holding_lots`. With FIFO, `costRemoved` is taken from the oldest lots first. Switching method triggers a full **ledger replay**. Both views remain available in reports, so you can compare them with your NCCPL CGT statement.

### Worked example (fixture `wac-basic`)

| #   | Event                | Calculation                                                                                           | qty | totalCost   | avgCost    | realized       |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------- | --- | ----------- | ---------- | -------------- |
| 1   | BUY 100 @ 250.00     | value 25,000.00; comm max(75.00, 6.00)=75.00; SST 11.25 → fees 86.25                                  | 100 | 25,086.2500 | 250.862500 | —              |
| 2   | BUY 50 @ 270.00      | value 13,500.00; comm 40.50; SST 6.08 (6.075 rounded half-up) → fees 46.58                            | 150 | 38,632.8300 | 257.552200 | —              |
| 3   | SELL 60 @ 280.00     | value 16,800.00; comm 50.40; SST 7.56 → net 16,742.04; costRemoved = 38,632.83 × 60/150 = 15,453.1320 | 90  | 23,179.6980 | 257.552200 | **1,288.9080** |
| 4   | BONUS 10% (1 for 10) | +9 shares, cost unchanged                                                                             | 99  | 23,179.6980 | 234.138364 | —              |

## 4. Corporate actions

| Action              | Treatment                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bonus** (n for m) | `qty += floor(qty × n/m)`; totalCost unchanged → avg ↓. Fractional entitlements: the company typically sells fractions and pays cash. That cash is recorded as `ADJUSTMENT` income with zero cost (policy flag, overridable). Lots: bonus shares get their own lot at cost 0, dated on the original lot dates for holding-period purposes (configurable; must be verified for CGT). |
| **Split** (a:b)     | `qty × a/b`; totalCost unchanged. Lots are adjusted proportionally.                                                                                                                                                                                                                                                                                                                 |
| **Rights**          | Entitlement is recorded. Subscribing is a `RIGHTS_SUBSCRIPTION` buy at the subscription price (plus fees). Selling the entitlement is realized income with zero cost basis (policy flag).                                                                                                                                                                                           |
| **Cash dividend**   | Income only (§6). No basis change.                                                                                                                                                                                                                                                                                                                                                  |

Corporate actions are posted on the **ex/book-closure date** before any trades on that date.

## 5. Valuation & P&L definitions

| Metric                       | Formula                                                                                                                                     | Label                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Market value (holding)       | `qty × lastPrice`                                                                                                                           | price provenance shown (PROVIDER / SIMULATED / USER_REPORTED)           |
| Unrealized P&L               | `marketValue − totalCost`                                                                                                                   | ESTIMATED (price-dependent)                                             |
| Liquidation value (optional) | `marketValue − estimated sell fees`                                                                                                         | ESTIMATED                                                               |
| Realized P&L                 | Σ realized on SELL transactions                                                                                                             | BROKER_CONFIRMED only when every contributing fill and fee is confirmed |
| Portfolio weight             | `holding MV / Σ holdings MV`                                                                                                                |                                                                         |
| Cash balance                 | Σ `cash_movements.amount`. The latest `broker_balance_snapshots.cashBalance` is shown alongside, and a mismatch raises a `SYNC_DISCREPANCY` |                                                                         |
| Account value                | cash + Σ market value                                                                                                                       |                                                                         |
| Invested amount              | Σ totalCost of open holdings (cost of what you hold now). Also shown: net contributions = deposits − withdrawals                            |                                                                         |
| Today's P&L                  | `V_today − V_prevClose − netExternalFlows_today`                                                                                            |                                                                         |
| Monthly P&L                  | Σ daily P&L over the month                                                                                                                  |                                                                         |
| Simple return                | `(accountValue − netContributions) / netContributions`                                                                                      |                                                                         |
| **TWR** (performance)        | daily `r_t = (V_t − F_t) / V_{t−1} − 1`, flows at end of day; linked `Π(1+r_t) − 1`                                                         | primary "portfolio return %"                                            |
| **XIRR** (your return)       | money-weighted, over the dated contributions and withdrawals plus current value                                                             |                                                                         |
| Dividends received           | Σ net of PAID or RECONCILED entitlements                                                                                                    | gross / WHT / net shown separately                                      |
| Fees & taxes                 | Σ `transaction_fees` by component, plus TAX cash movements                                                                                  | estimate vs confirmed split                                             |

## 6. Dividends

```
gross = sharesEligible × dividendPerShare
wht   = gross × taxRate(DIVIDEND_WITHHOLDING, filerStatus, paymentDate)
net   = gross − wht − zakat
```

- **Eligibility:** shares that are _settled_ in the portfolio **strictly before** book closure starts. The settlement cycle is configurable (`market.settlementDays`); with T+n settlement, the last qualifying trade date is **T−(n+1) trading days** before book-closure start (implemented in `finance-core/ledger`, ADR-018 §5). Check this against actual entitlements.
- Lifecycle: `ANNOUNCED` → `ENTITLED` (computed, ESTIMATED) → `PAID` (cash movement) → `RECONCILED` (matched to a broker or CDC statement, BROKER_CONFIRMED).

## 7. Ordering & replay

- Within a date, postings are ordered: corporate actions → trades by execution time (if known), otherwise contract-note line order → cash movements.
- `holdings`, `holding_lots` and `portfolio_snapshots` are pure functions of the ordered ledger. The replay job rebuilds them from any date. It runs after a reconciliation that alters history (for example, a confirmed fee replacing an estimate). A property test asserts that **replay(ledger) == incremental state**.

## 8. Reconciliation (estimate → confirmed)

1. A contract-note row is parsed. It is matched against existing `USER_REPORTED`/`ESTIMATED` executions on (date, symbol, side, qty, price ± 0.01).
2. **Match:** the original transaction is reversed and reposted with confirmed fees and `source=BROKER_CONFIRMED`, and replay runs from that date. The order is linked and its status moves to `FILLED` (confirmed).
3. **No match:** a new confirmed transaction is created. This covers trades placed directly in the KTrade app.
4. **Statement-level checks:** holdings quantity vs CDC/broker holdings, and cash vs ledger balance. Differences above tolerance raise `SYNC_DISCREPANCY`, and nothing is auto-corrected.

## 9. Paper trading & backtesting

They use the identical fee engine and WAC code, with `source=SIMULATED`. Fill models are described in [08](08-strategy-and-trading-engine.md). Simulated results are never mixed into LIVE portfolio figures.
