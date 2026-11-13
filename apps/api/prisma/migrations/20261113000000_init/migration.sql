-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'VIEWER');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('BROKER_CONFIRMED', 'BROKER_DISPLAYED', 'PROVIDER', 'USER_REPORTED', 'ESTIMATED', 'SIMULATED');

-- CreateEnum
CREATE TYPE "PortfolioKind" AS ENUM ('LIVE', 'PAPER');

-- CreateEnum
CREATE TYPE "CostBasisMethod" AS ENUM ('WEIGHTED_AVERAGE', 'FIFO');

-- CreateEnum
CREATE TYPE "TaxFilerStatus" AS ENUM ('FILER', 'NON_FILER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BrokerAdapterKind" AS ENUM ('MANUAL_IMPORT', 'PAPER', 'KTRADE_OFFICIAL_API', 'KTRADE_BROWSER');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('DISABLED', 'PENDING_AUTHORIZATION', 'PENDING_USER_LOGIN', 'CONNECTED', 'SESSION_EXPIRED', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('DAY', 'GTC');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('BACKTEST', 'PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "OrderOrigin" AS ENUM ('MANUAL', 'STRATEGY', 'ALERT', 'AI_SUGGESTION');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PREVIEWED', 'REJECTED_BY_RISK', 'APPROVED', 'EXPIRED', 'AWAITING_MANUAL_PLACEMENT', 'PLACED_BY_USER', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED_BY_BROKER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('BUY', 'SELL', 'BONUS_IN', 'SPLIT_ADJUSTMENT', 'RIGHTS_SUBSCRIPTION', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE_DEBIT', 'TRADE_CREDIT', 'FEE', 'TAX', 'DIVIDEND', 'PROFIT_ON_IDLE_FUNDS', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "FeeComponent" AS ENUM ('COMMISSION', 'SST_ON_COMMISSION', 'CDC_CHARGES', 'NCCPL_CHARGES', 'SECP_LEVY', 'PSX_LEVY', 'CVT', 'CGT', 'DIVIDEND_WHT', 'ZAKAT', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeAppliesTo" AS ENUM ('BUY', 'SELL', 'BOTH', 'DIVIDEND');

-- CreateEnum
CREATE TYPE "FeeMethod" AS ENUM ('PCT_OF_VALUE', 'PER_SHARE', 'MAX_OF_PCT_OR_PER_SHARE', 'FIXED', 'PCT_OF_COMPONENT', 'AT_ACTUAL');

-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('CAPITAL_GAINS', 'DIVIDEND_WITHHOLDING');

-- CreateEnum
CREATE TYPE "CorporateActionType" AS ENUM ('CASH_DIVIDEND', 'BONUS', 'SPLIT', 'REVERSE_SPLIT', 'RIGHTS');

-- CreateEnum
CREATE TYPE "DividendPaymentStatus" AS ENUM ('ANNOUNCED', 'ENTITLED', 'PAID', 'RECONCILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('CONTRACT_NOTE', 'LEDGER_STATEMENT', 'HOLDINGS_STATEMENT', 'CDC_STATEMENT', 'DIVIDEND_STATEMENT', 'GENERIC_TRANSACTIONS_CSV', 'PRICE_HISTORY_CSV');

-- CreateEnum
CREATE TYPE "ImportChannel" AS ENUM ('UPLOAD', 'MAILBOX', 'BROWSER_ADAPTER', 'BROKER_API');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PARSING', 'AWAITING_REVIEW', 'COMMITTING', 'COMMITTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'DUPLICATE', 'MATCHED', 'COMMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PriceInterval" AS ENUM ('M1', 'M5', 'M15', 'H1', 'D1');

-- CreateEnum
CREATE TYPE "StrategyType" AS ENUM ('MA_CROSSOVER', 'RSI', 'MACD', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'PRICE_ALERT', 'CUSTOM_RULES');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('ENTRY', 'EXIT');

-- CreateEnum
CREATE TYPE "SignalReason" AS ENUM ('RULE_ENTRY', 'RULE_EXIT', 'STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT', 'PRICE_TARGET', 'MANUAL');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('NEW', 'ORDER_PREPARED', 'AUTO_EXECUTED_PAPER', 'DISMISSED', 'EXPIRED', 'BLOCKED_BY_RISK');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('PRICE_ABOVE', 'PRICE_BELOW', 'PCT_CHANGE_ABOVE', 'PCT_CHANGE_BELOW', 'VOLUME_SPIKE', 'PORTFOLIO_DAILY_LOSS', 'POSITION_STOP_LOSS', 'ORDER_EXECUTED', 'ORDER_REJECTED', 'DIVIDEND_ANNOUNCED', 'DIVIDEND_RECEIVED', 'STRATEGY_SIGNAL', 'SYNC_DISCREPANCY', 'BROKER_SESSION_EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER', 'STRATEGY', 'BROWSER_AGENT');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OWNER',
    "totpSecretEnc" BYTEA,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "userId" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'PKR',
    "taxFilerStatus" "TaxFilerStatus" NOT NULL DEFAULT 'UNKNOWN',
    "defaultPortfolioId" UUID,
    "aiDataSharingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokeReason" TEXT,
    "replacedById" UUID,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_vault" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "credential_vault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "brokerCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "clientCodeMasked" TEXT,
    "uinMasked" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'PKR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "broker_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_connections" (
    "id" UUID NOT NULL,
    "brokerAccountId" UUID NOT NULL,
    "adapter" "BrokerAdapterKind" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'DISABLED',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "authorizationRef" TEXT,
    "authorizedAt" TIMESTAMPTZ(6),
    "credentialId" UUID,
    "lastSyncAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "broker_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_balance_snapshots" (
    "id" UUID NOT NULL,
    "brokerAccountId" UUID NOT NULL,
    "asOf" TIMESTAMPTZ(6) NOT NULL,
    "cashBalance" DECIMAL(20,4) NOT NULL,
    "buyingPower" DECIMAL(20,4),
    "unsettled" DECIMAL(20,4),
    "source" "DataSource" NOT NULL,
    "importedStmtId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_balance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "brokerAccountId" UUID,
    "name" TEXT NOT NULL,
    "kind" "PortfolioKind" NOT NULL,
    "costBasisMethod" "CostBasisMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'PKR',
    "initialCash" DECIMAL(20,4),
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdings" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "avgCost" DECIMAL(20,6) NOT NULL,
    "totalCost" DECIMAL(20,4) NOT NULL,
    "realizedPnl" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "firstBuyAt" DATE,
    "lastTxnAt" DATE,
    "lastConfirmed" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holding_lots" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "openTransactionId" UUID NOT NULL,
    "openDate" DATE NOT NULL,
    "originalQty" DECIMAL(20,4) NOT NULL,
    "remainingQty" DECIMAL(20,4) NOT NULL,
    "unitCost" DECIMAL(20,6) NOT NULL,
    "closedAt" DATE,

    CONSTRAINT "holding_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "tradeDate" DATE NOT NULL,
    "settlementDate" DATE,
    "quantity" DECIMAL(20,4) NOT NULL,
    "price" DECIMAL(20,6) NOT NULL,
    "grossAmount" DECIMAL(20,4) NOT NULL,
    "feesTotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "taxesTotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(20,4) NOT NULL,
    "realizedPnl" DECIMAL(20,4),
    "avgCostBefore" DECIMAL(20,6),
    "avgCostAfter" DECIMAL(20,6),
    "source" "DataSource" NOT NULL,
    "externalRef" TEXT,
    "importedStmtId" UUID,
    "executionId" UUID,
    "corporateActionId" UUID,
    "notes" TEXT,
    "reversedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_fees" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "component" "FeeComponent" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "source" "DataSource" NOT NULL,
    "scheduleId" UUID,

    CONSTRAINT "transaction_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "valueDate" DATE NOT NULL,
    "description" TEXT,
    "source" "DataSource" NOT NULL,
    "externalRef" TEXT,
    "transactionId" UUID,
    "importedStmtId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "marketValue" DECIMAL(20,4) NOT NULL,
    "cashBalance" DECIMAL(20,4) NOT NULL,
    "totalValue" DECIMAL(20,4) NOT NULL,
    "netContributions" DECIMAL(20,4) NOT NULL,
    "investedCost" DECIMAL(20,4) NOT NULL,
    "unrealizedPnl" DECIMAL(20,4) NOT NULL,
    "realizedPnlCum" DECIMAL(20,4) NOT NULL,
    "dividendsCum" DECIMAL(20,4) NOT NULL,
    "feesCum" DECIMAL(20,4) NOT NULL,
    "taxesCum" DECIMAL(20,4) NOT NULL,
    "dailyPnl" DECIMAL(20,4) NOT NULL,
    "dailyReturn" DECIMAL(20,10) NOT NULL,
    "priceSource" "DataSource" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" UUID NOT NULL,
    "brokerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "sourceNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_schedule_items" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "component" "FeeComponent" NOT NULL,
    "appliesTo" "FeeAppliesTo" NOT NULL,
    "method" "FeeMethod" NOT NULL,
    "rate" DECIMAL(12,8),
    "perShare" DECIMAL(20,6),
    "fixedAmount" DECIMAL(20,4),
    "minAmount" DECIMAL(20,4),
    "baseComponent" "FeeComponent",
    "capitalise" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fee_schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "taxType" "TaxType" NOT NULL,
    "filerStatus" "TaxFilerStatus" NOT NULL,
    "minHoldingDays" INTEGER,
    "maxHoldingDays" INTEGER,
    "rate" DECIMAL(12,8) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "sourceNote" TEXT,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_limits" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "maxOrderValue" DECIMAL(20,4) NOT NULL,
    "maxOrderQty" DECIMAL(20,4) NOT NULL,
    "maxDailyTradedValue" DECIMAL(20,4) NOT NULL,
    "maxDailyOrders" INTEGER NOT NULL,
    "maxPositionPct" DECIMAL(8,4) NOT NULL,
    "priceBandPct" DECIMAL(8,4) NOT NULL,
    "maxDailyLossPct" DECIMAL(8,4) NOT NULL,
    "allowMarketOrders" BOOLEAN NOT NULL DEFAULT false,
    "liveAutoExecutionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "risk_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "origin" "OrderOrigin" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "timeInForce" "TimeInForce" NOT NULL DEFAULT 'DAY',
    "quantity" DECIMAL(20,4) NOT NULL,
    "limitPrice" DECIMAL(20,6),
    "stopPrice" DECIMAL(20,6),
    "referencePrice" DECIMAL(20,6),
    "referencePriceSrc" "DataSource",
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "statusSource" "DataSource" NOT NULL DEFAULT 'USER_REPORTED',
    "idempotencyKey" TEXT NOT NULL,
    "previewHash" TEXT,
    "previewExpiresAt" TIMESTAMPTZ(6),
    "estNotional" DECIMAL(20,4),
    "estFees" DECIMAL(20,4),
    "estTotal" DECIMAL(20,4),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "submittedAt" TIMESTAMPTZ(6),
    "adapter" "BrokerAdapterKind",
    "brokerOrderRef" TEXT,
    "filledQuantity" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "avgFillPrice" DECIMAL(20,6),
    "rejectionReason" TEXT,
    "strategyId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" BIGSERIAL NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_risk_checks" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "observed" TEXT,
    "limit" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_risk_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_executions" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "price" DECIMAL(20,6) NOT NULL,
    "executedAt" TIMESTAMPTZ(6) NOT NULL,
    "brokerExecRef" TEXT,
    "source" "DataSource" NOT NULL,
    "importedStmtId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT,
    "isShariah" BOOLEAN,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "faceValue" DECIMAL(20,4),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_prices" (
    "id" BIGSERIAL NOT NULL,
    "stockId" UUID NOT NULL,
    "interval" "PriceInterval" NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(20,6) NOT NULL,
    "high" DECIMAL(20,6) NOT NULL,
    "low" DECIMAL(20,6) NOT NULL,
    "close" DECIMAL(20,6) NOT NULL,
    "volume" BIGINT NOT NULL,
    "isAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "providerKey" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,

    CONSTRAINT "stock_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_quotes" (
    "stockId" UUID NOT NULL,
    "last" DECIMAL(20,6) NOT NULL,
    "open" DECIMAL(20,6),
    "prevClose" DECIMAL(20,6),
    "high" DECIMAL(20,6),
    "low" DECIMAL(20,6),
    "volume" BIGINT,
    "change" DECIMAL(20,6),
    "changePct" DECIMAL(12,6),
    "asOf" TIMESTAMPTZ(6) NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "providerKey" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,

    CONSTRAINT "stock_quotes_pkey" PRIMARY KEY ("stockId")
);

-- CreateTable
CREATE TABLE "market_holidays" (
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "market_holidays_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "watchlists" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_stocks" (
    "watchlistId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_stocks_pkey" PRIMARY KEY ("watchlistId","stockId")
);

-- CreateTable
CREATE TABLE "corporate_actions" (
    "id" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "type" "CorporateActionType" NOT NULL,
    "announcementDate" DATE,
    "exDate" DATE,
    "bookClosureFrom" DATE,
    "bookClosureTo" DATE,
    "ratioNumerator" DECIMAL(20,6),
    "ratioDenominator" DECIMAL(20,6),
    "subscriptionPrice" DECIMAL(20,6),
    "appliedAt" TIMESTAMPTZ(6),
    "source" "DataSource" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dividends" (
    "id" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "corporateActionId" UUID,
    "announcementDate" DATE,
    "bookClosureFrom" DATE NOT NULL,
    "bookClosureTo" DATE,
    "paymentDate" DATE,
    "dividendPerShare" DECIMAL(20,6) NOT NULL,
    "source" "DataSource" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dividends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dividend_entitlements" (
    "id" UUID NOT NULL,
    "dividendId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "sharesEligible" DECIMAL(20,4) NOT NULL,
    "grossAmount" DECIMAL(20,4) NOT NULL,
    "whtRate" DECIMAL(12,8) NOT NULL,
    "whtAmount" DECIMAL(20,4) NOT NULL,
    "zakatAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(20,4) NOT NULL,
    "status" "DividendPaymentStatus" NOT NULL DEFAULT 'ENTITLED',
    "paidAt" DATE,
    "cashMovementId" UUID,
    "source" "DataSource" NOT NULL,
    "reconciledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dividend_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_statements" (
    "id" UUID NOT NULL,
    "brokerAccountId" UUID NOT NULL,
    "uploadedById" UUID,
    "kind" "ImportKind" NOT NULL,
    "channel" "ImportChannel" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "storagePath" TEXT,
    "emailMessageId" TEXT,
    "parserKey" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsCommitted" INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "rowsMatched" INTEGER NOT NULL DEFAULT 0,
    "rowsInvalid" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "committedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imported_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_rows" (
    "id" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "rowType" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "fingerprint" TEXT NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "matchedEntityType" TEXT,
    "matchedEntityId" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "imported_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_strategies" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StrategyType" NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "interval" "PriceInterval" NOT NULL DEFAULT 'D1',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "entryRules" JSONB NOT NULL,
    "exitRules" JSONB NOT NULL,
    "stopLossPct" DECIMAL(8,4),
    "takeProfitPct" DECIMAL(8,4),
    "trailingStopPct" DECIMAL(8,4),
    "maxInvestment" DECIMAL(20,4) NOT NULL,
    "maxPositionQty" DECIMAL(20,4),
    "riskPerTradePct" DECIMAL(8,4),
    "cooldownBars" INTEGER NOT NULL DEFAULT 1,
    "autoExecute" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastEvaluatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trading_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_parameters" (
    "id" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,

    CONSTRAINT "strategy_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_signals" (
    "id" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "stockId" UUID NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "type" "SignalType" NOT NULL,
    "reason" "SignalReason" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "barTs" TIMESTAMPTZ(6) NOT NULL,
    "price" DECIMAL(20,6) NOT NULL,
    "priceSource" "DataSource" NOT NULL,
    "suggestedQty" DECIMAL(20,4),
    "indicators" JSONB NOT NULL,
    "strategyVersion" INTEGER NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'NEW',
    "orderId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_executions" (
    "id" UUID NOT NULL,
    "strategyId" UUID NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "status" "RunStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "barTs" TIMESTAMPTZ(6),
    "signalsGenerated" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "strategy_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_results" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "strategyId" UUID,
    "strategyType" "StrategyType" NOT NULL,
    "symbol" TEXT NOT NULL,
    "interval" "PriceInterval" NOT NULL,
    "params" JSONB NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "initialCapital" DECIMAL(20,4) NOT NULL,
    "finalEquity" DECIMAL(20,4),
    "totalReturnPct" DECIMAL(12,6),
    "cagrPct" DECIMAL(12,6),
    "maxDrawdownPct" DECIMAL(12,6),
    "sharpe" DECIMAL(12,6),
    "winRatePct" DECIMAL(12,6),
    "tradesCount" INTEGER,
    "feesTotal" DECIMAL(20,4),
    "benchmarkReturn" DECIMAL(12,6),
    "equityCurve" JSONB,
    "dataSource" "DataSource" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "backtest_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_trades" (
    "id" UUID NOT NULL,
    "backtestId" UUID NOT NULL,
    "entryTs" TIMESTAMPTZ(6) NOT NULL,
    "exitTs" TIMESTAMPTZ(6),
    "quantity" DECIMAL(20,4) NOT NULL,
    "entryPrice" DECIMAL(20,6) NOT NULL,
    "exitPrice" DECIMAL(20,6),
    "fees" DECIMAL(20,4) NOT NULL,
    "pnl" DECIMAL(20,4),
    "exitReason" "SignalReason",

    CONSTRAINT "backtest_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "stockId" UUID,
    "portfolioId" UUID,
    "threshold" DECIMAL(20,6),
    "params" JSONB NOT NULL DEFAULT '{}',
    "channels" "NotificationChannel"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggerOnce" BOOLEAN NOT NULL DEFAULT false,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastTriggeredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "alertId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMPTZ(6),
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel_configs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "target" TEXT,
    "credentialId" UUID,
    "quietHours" JSONB,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_channel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replacedById_key" ON "refresh_tokens"("replacedById");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "credential_vault_userId_provider_label_key" ON "credential_vault"("userId", "provider", "label");

-- CreateIndex
CREATE UNIQUE INDEX "broker_accounts_userId_brokerCode_displayName_key" ON "broker_accounts"("userId", "brokerCode", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "broker_connections_brokerAccountId_adapter_key" ON "broker_connections"("brokerAccountId", "adapter");

-- CreateIndex
CREATE INDEX "broker_balance_snapshots_brokerAccountId_asOf_idx" ON "broker_balance_snapshots"("brokerAccountId", "asOf" DESC);

-- CreateIndex
CREATE INDEX "portfolios_brokerAccountId_idx" ON "portfolios"("brokerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_userId_name_key" ON "portfolios"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "holdings_portfolioId_stockId_key" ON "holdings"("portfolioId", "stockId");

-- CreateIndex
CREATE INDEX "holding_lots_portfolioId_stockId_openDate_idx" ON "holding_lots"("portfolioId", "stockId", "openDate");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_executionId_key" ON "transactions"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reversedById_key" ON "transactions"("reversedById");

-- CreateIndex
CREATE INDEX "transactions_portfolioId_tradeDate_idx" ON "transactions"("portfolioId", "tradeDate");

-- CreateIndex
CREATE INDEX "transactions_portfolioId_stockId_tradeDate_idx" ON "transactions"("portfolioId", "stockId", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_portfolioId_externalRef_stockId_type_key" ON "transactions"("portfolioId", "externalRef", "stockId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_fees_transactionId_component_key" ON "transaction_fees"("transactionId", "component");

-- CreateIndex
CREATE INDEX "cash_movements_portfolioId_valueDate_idx" ON "cash_movements"("portfolioId", "valueDate");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_portfolioId_externalRef_type_key" ON "cash_movements"("portfolioId", "externalRef", "type");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_snapshots_portfolioId_date_key" ON "portfolio_snapshots"("portfolioId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedules_brokerCode_effectiveFrom_key" ON "fee_schedules"("brokerCode", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedule_items_scheduleId_component_appliesTo_key" ON "fee_schedule_items"("scheduleId", "component", "appliesTo");

-- CreateIndex
CREATE INDEX "tax_rates_taxType_filerStatus_effectiveFrom_idx" ON "tax_rates"("taxType", "filerStatus", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "risk_limits_portfolioId_key" ON "risk_limits"("portfolioId");

-- CreateIndex
CREATE INDEX "orders_portfolioId_status_idx" ON "orders"("portfolioId", "status");

-- CreateIndex
CREATE INDEX "orders_portfolioId_createdAt_idx" ON "orders"("portfolioId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "orders_adapter_brokerOrderRef_key" ON "orders"("adapter", "brokerOrderRef");

-- CreateIndex
CREATE INDEX "order_events_orderId_createdAt_idx" ON "order_events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_risk_checks_orderId_idx" ON "order_risk_checks"("orderId");

-- CreateIndex
CREATE INDEX "order_executions_orderId_idx" ON "order_executions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_executions_portfolioId_brokerExecRef_key" ON "order_executions"("portfolioId", "brokerExecRef");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_symbol_key" ON "stocks"("symbol");

-- CreateIndex
CREATE INDEX "stocks_sector_idx" ON "stocks"("sector");

-- CreateIndex
CREATE INDEX "stock_prices_ts_idx" ON "stock_prices" USING BRIN ("ts");

-- CreateIndex
CREATE UNIQUE INDEX "stock_prices_stockId_interval_isAdjusted_ts_key" ON "stock_prices"("stockId", "interval", "isAdjusted", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "watchlists_userId_name_key" ON "watchlists"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_actions_stockId_type_bookClosureFrom_key" ON "corporate_actions"("stockId", "type", "bookClosureFrom");

-- CreateIndex
CREATE UNIQUE INDEX "dividends_corporateActionId_key" ON "dividends"("corporateActionId");

-- CreateIndex
CREATE UNIQUE INDEX "dividends_stockId_bookClosureFrom_key" ON "dividends"("stockId", "bookClosureFrom");

-- CreateIndex
CREATE UNIQUE INDEX "dividend_entitlements_cashMovementId_key" ON "dividend_entitlements"("cashMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "dividend_entitlements_dividendId_portfolioId_key" ON "dividend_entitlements"("dividendId", "portfolioId");

-- CreateIndex
CREATE INDEX "imported_statements_brokerAccountId_createdAt_idx" ON "imported_statements"("brokerAccountId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "imported_statements_brokerAccountId_fileSha256_key" ON "imported_statements"("brokerAccountId", "fileSha256");

-- CreateIndex
CREATE UNIQUE INDEX "imported_statements_brokerAccountId_emailMessageId_key" ON "imported_statements"("brokerAccountId", "emailMessageId");

-- CreateIndex
CREATE INDEX "imported_rows_fingerprint_idx" ON "imported_rows"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "imported_rows_statementId_rowIndex_key" ON "imported_rows"("statementId", "rowIndex");

-- CreateIndex
CREATE INDEX "trading_strategies_isActive_interval_idx" ON "trading_strategies"("isActive", "interval");

-- CreateIndex
CREATE UNIQUE INDEX "trading_strategies_userId_name_key" ON "trading_strategies"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_parameters_strategyId_key_key" ON "strategy_parameters"("strategyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_signals_orderId_key" ON "strategy_signals"("orderId");

-- CreateIndex
CREATE INDEX "strategy_signals_status_createdAt_idx" ON "strategy_signals"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_signals_strategyId_barTs_type_reason_key" ON "strategy_signals"("strategyId", "barTs", "type", "reason");

-- CreateIndex
CREATE INDEX "strategy_executions_strategyId_startedAt_idx" ON "strategy_executions"("strategyId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "backtest_results_userId_createdAt_idx" ON "backtest_results"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "backtest_trades_backtestId_entryTs_idx" ON "backtest_trades"("backtestId", "entryTs");

-- CreateIndex
CREATE INDEX "alerts_isActive_type_idx" ON "alerts"("isActive", "type");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_channel_dedupeKey_key" ON "notifications"("userId", "channel", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_configs_userId_channel_key" ON "notification_channel_configs"("userId", "channel");

-- CreateIndex
CREATE INDEX "ai_conversations_userId_updatedAt_idx" ON "ai_conversations"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_occurredAt_idx" ON "audit_logs"("actorUserId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_occurredAt_idx" ON "audit_logs"("action", "occurredAt" DESC);

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_vault" ADD CONSTRAINT "credential_vault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "credential_vault"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_balance_snapshots" ADD CONSTRAINT "broker_balance_snapshots_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_balance_snapshots" ADD CONSTRAINT "broker_balance_snapshots_importedStmtId_fkey" FOREIGN KEY ("importedStmtId") REFERENCES "imported_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "broker_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holding_lots" ADD CONSTRAINT "holding_lots_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holding_lots" ADD CONSTRAINT "holding_lots_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holding_lots" ADD CONSTRAINT "holding_lots_openTransactionId_fkey" FOREIGN KEY ("openTransactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_importedStmtId_fkey" FOREIGN KEY ("importedStmtId") REFERENCES "imported_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "order_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_corporateActionId_fkey" FOREIGN KEY ("corporateActionId") REFERENCES "corporate_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "fee_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_importedStmtId_fkey" FOREIGN KEY ("importedStmtId") REFERENCES "imported_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_schedule_items" ADD CONSTRAINT "fee_schedule_items_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "fee_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "trading_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_risk_checks" ADD CONSTRAINT "order_risk_checks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_importedStmtId_fkey" FOREIGN KEY ("importedStmtId") REFERENCES "imported_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_prices" ADD CONSTRAINT "stock_prices_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_quotes" ADD CONSTRAINT "stock_quotes_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_stocks" ADD CONSTRAINT "watchlist_stocks_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_stocks" ADD CONSTRAINT "watchlist_stocks_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_corporateActionId_fkey" FOREIGN KEY ("corporateActionId") REFERENCES "corporate_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividend_entitlements" ADD CONSTRAINT "dividend_entitlements_dividendId_fkey" FOREIGN KEY ("dividendId") REFERENCES "dividends"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividend_entitlements" ADD CONSTRAINT "dividend_entitlements_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dividend_entitlements" ADD CONSTRAINT "dividend_entitlements_cashMovementId_fkey" FOREIGN KEY ("cashMovementId") REFERENCES "cash_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_statements" ADD CONSTRAINT "imported_statements_brokerAccountId_fkey" FOREIGN KEY ("brokerAccountId") REFERENCES "broker_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_statements" ADD CONSTRAINT "imported_statements_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_rows" ADD CONSTRAINT "imported_rows_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "imported_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_parameters" ADD CONSTRAINT "strategy_parameters_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "trading_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "trading_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_signals" ADD CONSTRAINT "strategy_signals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_executions" ADD CONSTRAINT "strategy_executions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "trading_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "trading_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "backtest_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channel_configs" ADD CONSTRAINT "notification_channel_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channel_configs" ADD CONSTRAINT "notification_channel_configs_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "credential_vault"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

