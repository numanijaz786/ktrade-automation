import { Module } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { DividendsController } from './dividends.controller.js';
import { DividendsService } from './dividends.service.js';
import { EntitlementsService } from './entitlements.service.js';

/**
 * Dividend declarations, entitlements and payments (docs/06 §6). Audit and notifications come from global modules.
 * LedgerService is stateless, so a local instance shares the exact row → event mapping without a module cycle
 * (same approach as SnapshotsModule).
 */
@Module({
  controllers: [DividendsController],
  providers: [LedgerService, MarketCalendarService, DividendsService, EntitlementsService],
})
export class DividendsModule {}
