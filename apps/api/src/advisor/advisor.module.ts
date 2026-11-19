import { Module } from '@nestjs/common';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { TradingModule } from '../trading/trading.module.js';
import { AdvisorAlertsService } from './advisor-alerts.service.js';
import { AdvisorDataService } from './advisor-data.service.js';
import { AdvisorController } from './advisor.controller.js';
import { AdvisorScheduler } from './advisor.scheduler.js';
import { AdvisorService } from './advisor.service.js';
import { LlmExplainer, TemplateExplainer } from './explanation.js';

/**
 * Wires the pure research engine (finance-core) to stored data: input builder, report endpoints, explanations,
 * and the optional post-close scheduler (ADVISOR_SCHEDULER). Reads only; it never places or approves orders.
 * Prisma, Audit, Clock, Config, Notifications and Snapshots are global.
 */
@Module({
  imports: [TradingModule, RecommendationsModule],
  controllers: [AdvisorController],
  providers: [
    MarketCalendarService,
    AdvisorDataService,
    AdvisorService,
    AdvisorAlertsService,
    AdvisorScheduler,
    TemplateExplainer,
    LlmExplainer,
  ],
  exports: [AdvisorService, AdvisorScheduler],
})
export class AdvisorModule {}
