import { Module } from '@nestjs/common';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsScheduler } from './alerts.scheduler.js';
import { AlertsService } from './alerts.service.js';

/** Alerts CRUD + evaluation (Phase 10). Notifications and PerformanceService come from global modules. */
@Module({
  imports: [MarketDataModule],
  controllers: [AlertsController],
  providers: [MarketCalendarService, AlertsService, AlertEvaluatorService, AlertsScheduler],
})
export class AlertsModule {}
