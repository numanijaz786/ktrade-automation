-- ── TOTP enrolment + replay protection ──────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "totpLastStep" BIGINT,
ADD COLUMN "totpPendingEnc" BYTEA;

-- ── Integrity constraints Prisma cannot express (docs/05 §4) ────────────────────
ALTER TABLE "holdings"
  ADD CONSTRAINT "holdings_quantity_non_negative" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "holdings_total_cost_non_negative" CHECK ("totalCost" >= 0);

ALTER TABLE "holding_lots"
  ADD CONSTRAINT "holding_lots_remaining_valid" CHECK ("remainingQty" >= 0 AND "remainingQty" <= "originalQty");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "orders_filled_within_quantity" CHECK ("filledQuantity" >= 0 AND "filledQuantity" <= "quantity"),
  ADD CONSTRAINT "orders_limit_price_required" CHECK (
    "type" NOT IN ('LIMIT', 'STOP_LIMIT') OR ("limitPrice" IS NOT NULL AND "limitPrice" > 0)
  ),
  ADD CONSTRAINT "orders_stop_price_required" CHECK (
    "type" NOT IN ('STOP_LOSS', 'STOP_LIMIT') OR ("stopPrice" IS NOT NULL AND "stopPrice" > 0)
  ),
  ADD CONSTRAINT "orders_mode_not_backtest" CHECK ("mode" <> 'BACKTEST');

ALTER TABLE "order_executions"
  ADD CONSTRAINT "order_executions_positive" CHECK ("quantity" > 0 AND "price" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_quantity_non_negative" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "transactions_price_non_negative" CHECK ("price" >= 0);

ALTER TABLE "stock_prices"
  ADD CONSTRAINT "stock_prices_ohlc_valid" CHECK (
    "low" > 0 AND "high" >= "low" AND "open" BETWEEN "low" AND "high" AND "close" BETWEEN "low" AND "high" AND "volume" >= 0
  );

ALTER TABLE "portfolios"
  ADD CONSTRAINT "portfolios_initial_cash_paper_only" CHECK (
    ("kind" = 'LIVE' AND "initialCash" IS NULL) OR ("kind" = 'PAPER' AND "initialCash" IS NOT NULL AND "initialCash" >= 0)
  ),
  ADD CONSTRAINT "portfolios_live_has_broker" CHECK ("kind" = 'PAPER' OR "brokerAccountId" IS NOT NULL);

ALTER TABLE "dividend_entitlements"
  ADD CONSTRAINT "dividend_entitlements_amounts_valid" CHECK (
    "sharesEligible" >= 0 AND "grossAmount" >= 0 AND "whtAmount" >= 0 AND "netAmount" <= "grossAmount"
  );

ALTER TABLE "risk_limits"
  ADD CONSTRAINT "risk_limits_positive" CHECK (
    "maxOrderValue" > 0 AND "maxOrderQty" > 0 AND "maxDailyTradedValue" > 0 AND "maxDailyOrders" > 0
    AND "maxPositionPct" > 0 AND "maxPositionPct" <= 100 AND "priceBandPct" > 0 AND "maxDailyLossPct" > 0
  );

-- One active strategy of a given type per symbol per portfolio (prevents duplicate signals/orders).
CREATE UNIQUE INDEX "trading_strategies_one_active_per_symbol_type"
  ON "trading_strategies" ("portfolioId", "stockId", "type") WHERE "isActive";

-- Fast lookup of live sessions by the auth guard.
CREATE INDEX "refresh_tokens_live_family" ON "refresh_tokens" ("familyId") WHERE "revokedAt" IS NULL;

-- ── Append-only audit trail & order event log (docs/04 §8) ─────────────────────
-- Enforced with triggers so it holds for every DB role, including the owner used in development.
CREATE OR REPLACE FUNCTION "forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% forbidden)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "order_events_append_only"
  BEFORE UPDATE OR DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "order_events_no_truncate"
  BEFORE TRUNCATE ON "order_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_mutation"();
