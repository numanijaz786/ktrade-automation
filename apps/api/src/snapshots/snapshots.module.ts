import { Global, Module } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PerformanceService } from './performance.service.js';
import { SnapshotScheduler } from './snapshot.scheduler.js';
import { SnapshotService } from './snapshot.service.js';
import { SnapshotsController } from './snapshots.controller.js';

/**
 * Daily portfolio snapshots + performance analytics (Phase 10). Global so the dashboard summary
 * (PortfolioService) and the alert evaluator can read snapshot-backed P&L without importing this module.
 * Deliberately does NOT import TradingModule (which consumes PerformanceService) — LedgerService is stateless
 * and dependency-free, so a local instance shares the exact row → event mapping without a module cycle.
 */
@Global()
@Module({
  controllers: [SnapshotsController],
  providers: [LedgerService, MarketCalendarService, SnapshotService, PerformanceService, SnapshotScheduler],
  exports: [SnapshotService, PerformanceService],
})
export class SnapshotsModule {}
