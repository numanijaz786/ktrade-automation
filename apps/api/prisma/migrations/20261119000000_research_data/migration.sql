-- CreateEnum
CREATE TYPE "FinancialPeriodType" AS ENUM ('QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "AnnouncementCategory" AS ENUM ('FINANCIAL_RESULT', 'DIVIDEND', 'BOOK_CLOSURE', 'BOARD_MEETING', 'CORPORATE_ACTION', 'MATERIAL', 'MACRO', 'SECTOR', 'OTHER');

-- CreateEnum
CREATE TYPE "SentimentLabel" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "SentimentSource" AS ENUM ('RULES', 'MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "MacroSeries" AS ENUM ('POLICY_RATE', 'CPI_YOY', 'USD_PKR', 'KIBOR_6M', 'KSE100_INDEX');

-- CreateEnum
CREATE TYPE "ResearchDataType" AS ENUM ('FUNDAMENTALS', 'ANNOUNCEMENTS', 'MACRO');

-- CreateEnum
CREATE TYPE "ProviderStatusKind" AS ENUM ('OK', 'DEGRADED', 'FAILED', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "RecommendationAction" AS ENUM ('BUY', 'SELL', 'HOLD', 'WATCHLIST', 'AVOID');

-- CreateEnum
CREATE TYPE "RecommendationHorizon" AS ENUM ('SHORT_TERM', 'MEDIUM_TERM', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('ACTIONABLE', 'NOT_ACTIONABLE');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('OPEN', 'TARGET_HIT', 'STOPPED', 'EXPIRED');

-- CreateTable
CREATE TABLE "company_financials" (
    "id" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "periodType" "FinancialPeriodType" NOT NULL,
    "periodEnd" DATE NOT NULL,
    "publishedAt" TIMESTAMPTZ(6) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PKR',
    "source" "DataSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "revenue" DECIMAL(24,4),
    "grossProfit" DECIMAL(24,4),
    "operatingProfit" DECIMAL(24,4),
    "netProfit" DECIMAL(24,4),
    "eps" DECIMAL(20,6),
    "totalAssets" DECIMAL(24,4),
    "totalEquity" DECIMAL(24,4),
    "totalDebt" DECIMAL(24,4),
    "operatingCashFlow" DECIMAL(24,4),
    "capex" DECIMAL(24,4),
    "sharesOutstanding" DECIMAL(24,4),
    "dividendPerShare" DECIMAL(20,6),
    "enteredById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_financials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "stockId" UUID,
    "symbols" TEXT[],
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT,
    "category" "AnnouncementCategory" NOT NULL DEFAULT 'OTHER',
    "source" "DataSource" NOT NULL,
    "sourceName" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(6) NOT NULL,
    "retrievedAt" TIMESTAMPTZ(6) NOT NULL,
    "dedupeHash" TEXT NOT NULL,
    "sentiment" "SentimentLabel",
    "sentimentSource" "SentimentSource" NOT NULL DEFAULT 'NONE',
    "relevance" INTEGER,
    "enteredById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "macro_observations" (
    "id" UUID NOT NULL,
    "series" "MacroSeries" NOT NULL,
    "date" DATE NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "source" "DataSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "macro_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_status" (
    "id" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "dataType" "ResearchDataType" NOT NULL,
    "lastAttemptAt" TIMESTAMPTZ(6),
    "lastSuccessAt" TIMESTAMPTZ(6),
    "status" "ProviderStatusKind" NOT NULL,
    "freshnessMinutes" INTEGER,
    "message" TEXT,
    "licenseNote" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "stockId" UUID NOT NULL,
    "horizon" "RecommendationHorizon" NOT NULL,
    "action" "RecommendationAction" NOT NULL,
    "status" "RecommendationStatus" NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL,
    "asOfBar" DATE NOT NULL,
    "price" DECIMAL(20,6) NOT NULL,
    "priceSource" "DataSource" NOT NULL,
    "entryLow" DECIMAL(20,6),
    "entryHigh" DECIMAL(20,6),
    "stop" DECIMAL(20,6),
    "target1" DECIMAL(20,6),
    "target2" DECIMAL(20,6),
    "target3" DECIMAL(20,6),
    "riskReward" DECIMAL(10,4),
    "holdingPeriod" TEXT,
    "holdingDaysMax" INTEGER,
    "confidence" DECIMAL(5,2) NOT NULL,
    "confidenceLevel" "ConfidenceLevel" NOT NULL,
    "components" JSONB NOT NULL DEFAULT '{}',
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "invalidations" JSONB NOT NULL DEFAULT '[]',
    "dataQuality" JSONB NOT NULL DEFAULT '{}',
    "engineVersion" TEXT NOT NULL,
    "inputsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_outcomes" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastBarDate" DATE NOT NULL,
    "status" "OutcomeStatus" NOT NULL,
    "maxFavourable" DECIMAL(12,4) NOT NULL,
    "maxAdverse" DECIMAL(12,4) NOT NULL,
    "target1HitAt" DATE,
    "target2HitAt" DATE,
    "target3HitAt" DATE,
    "stopHitAt" DATE,
    "closedAt" DATE,
    "exitPrice" DECIMAL(20,6),
    "returnPct" DECIMAL(12,4),
    "holdingDays" INTEGER NOT NULL,
    "benchmarkReturnPct" DECIMAL(12,4),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_financials_stockId_periodEnd_idx" ON "company_financials"("stockId", "periodEnd" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "company_financials_stockId_periodType_periodEnd_source_key" ON "company_financials"("stockId", "periodType", "periodEnd", "source");

-- CreateIndex
CREATE UNIQUE INDEX "announcements_dedupeHash_key" ON "announcements"("dedupeHash");

-- CreateIndex
CREATE INDEX "announcements_publishedAt_idx" ON "announcements"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "announcements_stockId_publishedAt_idx" ON "announcements"("stockId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "macro_observations_series_date_idx" ON "macro_observations"("series", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "macro_observations_series_date_source_key" ON "macro_observations"("series", "date", "source");

-- CreateIndex
CREATE UNIQUE INDEX "provider_status_providerKey_dataType_key" ON "provider_status"("providerKey", "dataType");

-- CreateIndex
CREATE INDEX "recommendations_userId_generatedAt_idx" ON "recommendations"("userId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "recommendations_stockId_generatedAt_idx" ON "recommendations"("stockId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "recommendations_status_action_horizon_idx" ON "recommendations"("status", "action", "horizon");

-- CreateIndex
CREATE INDEX "recommendation_outcomes_recommendationId_evaluatedAt_idx" ON "recommendation_outcomes"("recommendationId", "evaluatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_outcomes_recommendationId_lastBarDate_key" ON "recommendation_outcomes"("recommendationId", "lastBarDate");

-- AddForeignKey
ALTER TABLE "company_financials" ADD CONSTRAINT "company_financials_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_outcomes" ADD CONSTRAINT "recommendation_outcomes_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "recommendations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Integrity constraints (hand-written; Prisma cannot express them) ───────────

-- Fundamentals: published on/after the period ended (PKT); balance-sheet size items are never negative.
ALTER TABLE "company_financials"
  ADD CONSTRAINT "company_financials_published_after_period"
    CHECK (("publishedAt" AT TIME ZONE 'Asia/Karachi')::date >= "periodEnd"),
  ADD CONSTRAINT "company_financials_nonneg"
    CHECK (("totalAssets" IS NULL OR "totalAssets" >= 0)
       AND ("sharesOutstanding" IS NULL OR "sharesOutstanding" >= 0)
       AND ("totalDebt" IS NULL OR "totalDebt" >= 0)
       AND ("dividendPerShare" IS NULL OR "dividendPerShare" >= 0)),
  ADD CONSTRAINT "company_financials_has_item"
    CHECK (num_nonnulls("revenue","grossProfit","operatingProfit","netProfit","eps","totalAssets","totalEquity",
                        "totalDebt","operatingCashFlow","capex","sharesOutstanding","dividendPerShare") > 0);

-- Announcements: a stale or future-dated item cannot be recorded (publishedAt never after retrievedAt).
ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_published_not_future" CHECK ("publishedAt" <= "retrievedAt"),
  ADD CONSTRAINT "announcements_relevance_range" CHECK ("relevance" IS NULL OR ("relevance" BETWEEN 0 AND 100)),
  ADD CONSTRAINT "announcements_sentiment_consistent"
    CHECK (("sentiment" IS NULL AND "sentimentSource" = 'NONE') OR ("sentiment" IS NOT NULL AND "sentimentSource" <> 'NONE'));

ALTER TABLE "macro_observations"
  ADD CONSTRAINT "macro_positive_levels"
    CHECK ("series" NOT IN ('USD_PKR', 'KSE100_INDEX') OR "value" > 0);

-- Recommendations: sane levels; an ACTIONABLE one must be BUY/SELL with a stop and a first target on the correct side.
ALTER TABLE "recommendations"
  ADD CONSTRAINT "recommendations_price_positive" CHECK ("price" > 0),
  ADD CONSTRAINT "recommendations_confidence_range" CHECK ("confidence" BETWEEN 0 AND 100),
  ADD CONSTRAINT "recommendations_entry_order" CHECK ("entryLow" IS NULL OR "entryHigh" IS NULL OR "entryLow" <= "entryHigh"),
  ADD CONSTRAINT "recommendations_holding_days_positive" CHECK ("holdingDaysMax" IS NULL OR "holdingDaysMax" > 0),
  ADD CONSTRAINT "recommendations_actionable_levels"
    CHECK ("status" <> 'ACTIONABLE' OR (
      "action" IN ('BUY', 'SELL') AND "stop" IS NOT NULL AND "target1" IS NOT NULL AND (
        ("action" = 'BUY'  AND "stop" < "price" AND "target1" > "price") OR
        ("action" = 'SELL' AND "stop" > "price" AND "target1" < "price")
      )
    ));

-- Idempotent per user + stock + horizon + bar + engine version (system rows, userId NULL, included).
CREATE UNIQUE INDEX "recommendations_idempotency"
  ON "recommendations" (COALESCE("userId", '00000000-0000-0000-0000-000000000000'::uuid), "stockId", "horizon", "asOfBar", "engineVersion");

-- ── Append-only: recommendations and their outcomes (same trigger function as audit_logs) ──
CREATE TRIGGER "recommendations_append_only"
  BEFORE UPDATE OR DELETE ON "recommendations"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "recommendations_no_truncate"
  BEFORE TRUNCATE ON "recommendations"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "recommendation_outcomes_append_only"
  BEFORE UPDATE OR DELETE ON "recommendation_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();
CREATE TRIGGER "recommendation_outcomes_no_truncate"
  BEFORE TRUNCATE ON "recommendation_outcomes"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_mutation"();
