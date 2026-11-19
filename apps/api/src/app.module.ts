import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdvisorModule } from './advisor/advisor.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuditModule } from './audit/audit.service.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard, RolesGuard, StepUpGuard } from './auth/guards.js';
import { ClockModule } from './common/clock.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { LoggerModule } from './common/logging/logger.module.js';
import { ConfigModule } from './config/config.module.js';
import { DividendsModule } from './dividends/dividends.module.js';
import { HealthController } from './health/health.controller.js';
import { ImportsModule } from './imports/imports.module.js';
import { MarketDataModule } from './market-data/market-data.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RecommendationsModule } from './recommendations/recommendations.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ResearchDataModule } from './research-data/research-data.module.js';
import { SnapshotsModule } from './snapshots/snapshots.module.js';
import { StrategiesModule } from './strategies/strategies.module.js';
import { TradingModule } from './trading/trading.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ClockModule,
    PrismaModule,
    RedisModule,
    AuditModule,
    // In-memory store is correct for a single API instance; switch to a Redis store before scaling out (ADR-019).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    AuthModule,
    TradingModule,
    ImportsModule,
    MarketDataModule,
    StrategiesModule,
    NotificationsModule,
    SnapshotsModule,
    AlertsModule,
    DividendsModule,
    ResearchDataModule,
    RecommendationsModule,
    AdvisorModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global guard chain, in execution order. Default-deny: routes need auth unless @Public().
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // 1. rate limit before any auth work
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // 2. who are you (and is the session live)
    { provide: APP_GUARD, useClass: RolesGuard }, // 3. may you (VIEWER is read-only)
    { provide: APP_GUARD, useClass: StepUpGuard }, // 4. fresh second factor for 🔐 routes
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
