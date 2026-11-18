# 12 — Recommendation rules (finance-core `research`)

_Status: implemented 2026-11-19 in `packages/finance-core/src/research/`. Engine version `research-1.0.0`. Design context: docs/10. **This is a research aid, not financial advice. No return is guaranteed. Execution is always a separate, human-approved step.**_

Everything here is pure and deterministic: decimal-only, no I/O, no clock, no randomness. The same input gives the same output. Every function reads bars **up to and including the decision bar** only (bars after `asOf` are dropped and reported).

## 1. Modules

| Module            | Entry points                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `technical.ts`    | `adxSeries/adxAnalysis`, `swingPivots/supportResistance`, `volumeAnalysis`, `trendAnalysis`, `breakoutAnalysis`, `momentumScore`, `candlePatterns` |
| `fundamentals.ts` | `computeFundamentalRatios` and one function per ratio                                                                                              |
| `valuation.ts`    | `peerMedianMultiples`, `earningsFairValue`, `gordonGrowth`, `simpleDcf`, `marginOfSafetyPct`, `summariseValuation`                                 |
| `evaluate.ts`     | `evaluateStock`, `evaluateAllHorizons`                                                                                                             |
| `holding.ts`      | `evaluateHolding`                                                                                                                                  |
| `scanner.ts`      | `rankOpportunities`                                                                                                                                |
| `rules.ts`        | `RULE_TABLE` (the table in §4), `computeTechSnapshot`                                                                                              |

Existing engines are reused, not duplicated: SMA/EMA/RSI/MACD/ROC/ATR (`indicators`), `sizePosition` (`strategy`), `computeTradeFees` (`fees`).

## 2. Technical analysis definitions

Each result has `warm` (enough bars?) and an `explanation` list. Nothing is estimated while not warm.

- **ADX (Wilder).** TR, +DM, −DM seeded with the sum of the first `period` (14) values, then `S = S − S/period + x`. +DI/−DI = 100·S(DM)/S(TR). ADX is the mean of the first 14 DX, then Wilder-smoothed. Needs `2·period` bars. Strength: `< 20` NONE, `20–25` DEVELOPING, `>= 25` STRONG.
- **Support / resistance.** Swing pivot high at _i_: high strictly above the 3 previous highs and `>=` the 3 following highs (lows mirrored). A pivot is only known 3 bars later (no look-ahead). Pivot prices within 1% of the running cluster mean merge into one level (mean price, `touches` = pivots merged). A level at or below the last close is SUPPORT, otherwise RESISTANCE. Needs 30 bars.
- **Volume.** Relative volume = latest volume ÷ mean of the **20 bars before** it. Accumulation/distribution = cumulative Chaikin money-flow volume; trend = its change over 10 bars. Average daily traded value = mean(close × volume) over the latest 20 bars (used for liquidity).
- **Trend.** Conditions close>SMA20, SMA20>SMA50, SMA50>SMA100, SMA100>SMA200 (each evaluated only when both sides are warm). STRONG_UPTREND = all evaluated true and SMA50 slope (10 bars) > 0; UPTREND = at least 2/3 true and close > SMA50; mirrored for down; otherwise SIDEWAYS. `warm` needs all four (200 bars).
- **Breakout.** Levels are computed from bars **before** the latest. A level with `>= 2` touches is crossed when previous close ≤ level < close. Volume-confirmed when relative volume `>= 1.5x`.
- **Momentum score (0–100).** Four 25-point parts: RSI14 (30→0, 70→25 linear), MACD histogram (15 if > 0, +10 if rising), ROC20 (−10%→0, +10%→25), close vs SMA50 (−5%→0, +5%→25). `null` unless all four are available.
- **Candles (latest bar).** Doji: body ≤ 10% of range. Hammer: lower shadow ≥ 2× body, upper shadow ≤ 10% of range, after a decline (previous close below the close 5 bars earlier). Shooting star: mirrored after an advance. Bullish/bearish engulfing: opposite-colour previous bar whose body is fully engulfed (one side strict).

## 3. Fundamentals and valuation: refuse, never estimate

A ratio is `OK` (value, formula, every input with period/publishedAt/currency/source) or `UNAVAILABLE` (missing input **names** and a reason). It refuses when:

- an input is missing or null;
- a denominator is zero or non-positive (revenue, equity, shares, comparison revenue/EPS, EPS for P/E and payout);
- currencies differ (statement vs price vs dividends vs comparison period);
- periods are incompatible (YoY needs same type, exactly 12 months apart; QoQ needs quarterly statements 3 months apart);
- the statement is older than `maxAgeDays` (default 400 in the engine) or published after the decision date;
- the price is older than 7 days (price ratios).

**Annualisation is explicit.** Quarterly flows are never scaled silently. P/E, ROE and ROA on a quarterly statement refuse unless `annualiseQuarterly: true`; then the value is ×4 and carries the flag `ANNUALISED_FROM_QUARTERLY` (and the valuation lists it as an assumption). ROE/ROA use **period-end**, not average, equity/assets. Dividend yield = trailing-365-day dividends per share ÷ price; a missing history refuses, an empty history is yield 0 flagged `NO_DIVIDENDS_IN_SUPPLIED_HISTORY` (the caller vouches for completeness).

**Valuation** separates **reported facts** (sourced figures) from **assumptions** (each listed with its basis):

- Earnings multiple: annual EPS × justified P/E. The P/E is the **median of >= 3 supplied peers**, otherwise a supplied historical multiple; with neither, no earnings valuation.
- Gordon growth: `V = D0(1+g)/(r−g)`; refused unless `r > g`, `r > 0` and `D0 > 0`.
- DCF: only with every assumption supplied (growth, years 1–30, terminal growth, discount rate, net debt, shares); refused when `r <= terminal growth`, base FCF <= 0, or the equity value is not positive.
- Margin of safety = (fair − price)/fair; the **lowest** available fair value is used (conservative). A model value is never presented as a company or market figure.
- Peer comparison refuses with fewer than 3 peers having a positive multiple.

## 4. Rule table

A rule passes, fails, or is UNAVAILABLE (input missing). **Bull score** = % of available bullish weight that passed; **bear score** likewise. **Coverage** = % of total rule weight whose inputs were available. `S` = structural: only structural bearish rules (trend break / fundamental deterioration) can justify a SELL. RSI, MACD, candles, volume and momentum are never structural.

Thresholds (all configurable in `DEFAULT_RECOMMENDATION_CONFIG`): RSI healthy 45–70, overbought > 75; ADX 20; relative volume 1.2x; momentum strong ≥ 60 / weak ≤ 30; near support ≤ 1.5 ATR; ROE ≥ 12%; D/E ≤ 1.5 (bear > 3); growth high ≥ 15%; dividend yield ≥ 5%; payout ≤ 90% (bear > 100%); P/E ≤ 12; P/B ≤ 1.5; margin of safety ≥ 10% (deep: 20%), overvalued ≤ −20%.

| Horizon    | Bullish rules (weight)                                                                                                                                                | Bearish rules (weight)                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SHORT_TERM | close>SMA20 (2), RSI healthy (2), MACD hist>0 (2), rel. volume (1), momentum strong (2), ADX bullish (2), volume-confirmed breakout (3), bullish candle (1)           | trend down **S** (3), close<SMA50 **S** (2), RSI overbought (1), MACD hist<0 (2), ADX bearish (2), momentum weak (1), bearish candle (1) |
| SWING      | close>SMA50 (2), SMA20>SMA50 (2), trend up (3), ADX bullish (2), RSI healthy (1), momentum strong (2), near support (2), A/D accumulation (1), confirmed breakout (2) | trend down **S** (3), close<SMA50 **S** (2), ADX bearish (2), A/D distribution (1), MACD<0 (1), RSI overbought (1)                       |
| LONG_TERM  | close>SMA200 (2), SMA50>SMA200 (2), trend up (2), revenue growth>0 (2), net margin>0 (2), ROE (2), D/E ok (2), FCF>0 (2), margin of safety (3)                        | close<SMA200 & SMA50<SMA200 **S** (3), revenue shrinking **S** (2), net margin<0 **S** (3), FCF<0 (1), D/E high (2), overvalued (2)      |
| DIVIDEND   | yield (3), payout sustainable (2), dividends paid 3 of last 3 years (2), D/E ok (1), FCF>0 (1), net margin>0 (1), close>SMA200 (1), margin of safety (2)              | dividend cut **S** (3), payout>100% **S** (2), net margin<0 **S** (3), D/E high (1), close<SMA200 & SMA50<SMA200 **S** (2)               |
| VALUE      | P/E low (2), P/B low (2), deep margin of safety (3), ROE (1), D/E ok (1), FCF>0 (1), net margin>0 (1)                                                                 | net margin<0 **S** (3), revenue shrinking **S** (2), D/E high (2), close<SMA200 & SMA50<SMA200 **S** (1), overvalued (2)                 |
| GROWTH     | revenue growth ≥15% (3), EPS growth ≥15% (3), ROE (2), trend up (2), close>SMA50 (1), net margin>0 (1)                                                                | revenue shrinking **S** (3), EPS shrinking **S** (2), trend down **S** (2), net margin<0 **S** (2)                                       |

Dividend history counts completed calendar years by ex-date. "Dividend cut" = last completed year's total below the year before.

## 5. Action decision (first match wins)

1. `bear >= 65` and `bull <= 30` and at least one structural bearish rule passed: **SELL** if the stock is held, else **AVOID**.
2. `bear >= 65`: **AVOID** if not held; if held, **HOLD** (a decline without structural deterioration is not a sell reason).
3. `bear >= 50` and `bull < 35`: **AVOID** (not held) or **HOLD** (held).
4. `bull >= 80` and `bear <= 10`: **STRONG_BUY** candidate.
5. `bull >= 65` and `bear <= 25`: **BUY** candidate.
6. `bull >= 45`: **WATCHLIST**.
7. Otherwise **HOLD** ("no strong opportunity": keep an existing position, or stay out).

BUY-class candidates are then checked in order and **downgraded to WATCHLIST** (never silently kept) when: the liquidity floor is not met; confidence < 50 (STRONG_BUY needs ≥ 70, else BUY); price is more than 3 ATR above SMA20 (extended); no executable plan exists (no ATR, size 0 shares from cash/risk/concentration/sector limits); or risk:reward to **Target 2** is below 1.5 (STRONG_BUY needs ≥ 2, else BUY). The reason is appended to the headline and `watchFor` lists the failed bullish rules and what to wait for.

## 6. Hard gates (all unit-tested)

`NOT_ACTIONABLE` means `action = null`, **no plan** (no entry, stop, targets, size) and no confidence.

| Gate                                                                     | Result                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Latest bar `source = SIMULATED`                                          | NOT_ACTIONABLE, reason exactly `simulated data — not for investment decisions` (checked first, for every horizon)      |
| Fewer bars than required                                                 | NOT_ACTIONABLE: 60 daily bars for SHORT_TERM/SWING, **200** for LONG_TERM, DIVIDEND, VALUE, GROWTH                     |
| Latest price older than the freshness limit                              | NOT_ACTIONABLE (limit is supplied by the caller in minutes); a price timestamp after the decision time is also refused |
| Invalid bars (unordered, bad OHLC)                                       | NOT_ACTIONABLE                                                                                                         |
| Average daily traded value < floor                                       | ACTIONABLE but capped at WATCHLIST/AVOID/HOLD, no plan, `illiquid` warning (default floor PKR 5,000,000; configurable) |
| LONG_TERM/DIVIDEND/VALUE/GROWTH without fundamentals, or none computable | NOT_ACTIONABLE for that horizon only                                                                                   |
| Rule coverage < 50%                                                      | NOT_ACTIONABLE ("insufficient evidence")                                                                               |
| Latest bar `ESTIMATED`                                                   | Allowed, but confidence is capped at 39 (LOW) and so no BUY is produced                                                |
| Older SIMULATED/ESTIMATED bars in the last 60                            | Allowed; listed in `dataQuality`, lowers the data-quality component, warned                                            |

## 7. Trade plan (BUY / STRONG_BUY only)

- **Entry range:** high = last close × (1 + `entryTolerancePct`, default 0), so never above the last close unless a tolerance is set. Low = nearest support when it is within 1 ATR, else close − 0.5 ATR.
- **Stop:** the support-based stop (support − 0.25 ATR) when it lies between the ATR stop and 1 ATR below the price; otherwise close − k·ATR14 with k = 1.5 SHORT_TERM, 2 SWING, 3 for the long horizons. Always below the entry range.
- **Targets 1–3:** next resistance levels at least 0.5 ATR above the previous target; otherwise close + ATR multiples (SHORT 1.5/2.5/4, SWING 2/3.5/5, long horizons 4/7/10). Target 3 uses the conservative fair value when valuation is available and above Target 2.
- **Risk:reward** per target = (target − entry high)/(entry high − stop), plus a **net** figure that includes estimated buy and sell fees and taxes at the planned size (`computeTradeFees`). Upside % and downside % are given.
- **Size:** `sizePosition` with the risk-per-trade %, max-position %, cash, existing holding, and a sector cap (max sector % − current sector exposure), fee-aware; then verified against cash with the exact fee schedule (reduced share by share). Allocation % and max loss (incl. fees) are reported.
- **Expected holding period** by horizon: SHORT 1–10 trading days, SWING 10–40, LONG_TERM 6–24 months, DIVIDEND 1–4 years, VALUE/GROWTH 1–3 years.

## 8. Confidence (explicit components, never free-form)

`score = Σ weight × component / 100`; every component is listed with its inputs.

| Component        | Weight | Score (0–100)                                                                                                                                                                                                             |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATA_COVERAGE    | 30     | % of rule weight with inputs available                                                                                                                                                                                    |
| SIGNAL_AGREEMENT | 30     | BUY-class: bull − bear; SELL/AVOID: bear − bull; HOLD/WATCHLIST: 100 − max(bull, bear); clamped 0–100                                                                                                                     |
| LIQUIDITY        | 20     | avg traded value ÷ (4 × floor) × 100, capped at 100                                                                                                                                                                       |
| DATA_QUALITY     | 20     | 100 minus: latest-bar source (BROKER_DISPLAYED 10, USER_REPORTED 30, ESTIMATED 70), feed delay > 15 min 20, price age up to 30 (age ÷ limit × 30), SIMULATED/ESTIMATED bars in last 60: 20, USER_REPORTED fundamentals 10 |

Levels: LOW < 40, MEDIUM < 70, HIGH ≥ 70. Caps (listed in `caps`): ESTIMATED latest bar → 39.

## 9. Holdings advice (`evaluateHolding`)

Same gates as `evaluateStock` (no advice when NOT_ACTIONABLE). P&L uses the supplied average cost (fee-inclusive), estimated sell fees/taxes, realized P&L and dividends. Order of decision:

1. **EXIT**: a supplied stop is hit (close ≤ stop).
2. **EXIT**: the stock evaluation is SELL (structural deterioration).
3. **TARGET_REACHED**: close ≥ all supplied targets (sell the rest or trail a stop).
4. **PARTIAL_SELL**: some targets reached; sells 1/(remaining targets + 1) of the position (whole shares, at least 1).
5. **PARTIAL_SELL**: structural deterioration present with bear ≥ 50 but not decisive; sells half.
6. **CONTINUE_HOLDING** otherwise. An unrealized loss alone never triggers a sale. With no stop supplied, an ATR-based stop is shown and labelled `SUGGESTED_FROM_ATR`.

## 10. Scanner (`rankOpportunities`)

Evaluates each universe member for one horizon, keeps only ACTIONABLE results whose action is in the filter (default STRONG_BUY, BUY) and that pass `minConfidence`, `minRiskReward` (to Target 2), sector and exclusion filters. Sort: action rank, confidence desc, bull score desc, risk:reward desc, symbol ascending. The result lists every excluded symbol with its reason. An empty result is valid.

## 11. Limitations

- Rules are simple, transparent heuristics, not a validated trading edge. Thresholds are defaults, untuned on PSX data; backtest before relying on them (docs/08).
- Daily bars only; no intraday, corporate-action adjustment, circuit-limit or settlement-cycle modelling. Adjusted history must be supplied by the caller.
- Fundamentals are only as good as the supplied (often owner-entered) figures; ROE/ROA use period-end balances; peer sets are caller-chosen; DCF and DDM outputs are only as good as their listed assumptions.
- Estimated fees follow the supplied schedule; AT_ACTUAL components are not included and tax treatment is simplified.
- Confidence measures data quality and rule agreement, not the probability that a trade wins.
- Dividend history completeness is the caller's responsibility; ex-date years are calendar years.
- Position sizing assumes fills at the entry price; real fills can slip, especially in illiquid names.
- Fixtures in tests are synthetic and deliberately tiny; they are not real market data.
