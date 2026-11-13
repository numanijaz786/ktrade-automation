import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { TradingModule } from '../trading/trading.module.js';
import { BacktestsService } from './backtests.service.js';
import { BacktestsController, SignalsController, StrategiesController } from './strategies.controller.js';
import { StrategiesService } from './strategies.service.js';
import { StrategyScheduler } from './strategy.scheduler.js';
import { StrategyDataService } from './strategy-data.service.js';

/**
 * Strategies, signals and backtests (Phase 9, docs/08). Orders go through TradingModule's pipeline only;
 * this module never writes orders or the ledger directly. StrategyScheduler runs only with STRATEGY_SCHEDULER=true.
 */
@Module({
  imports: [AuthModule, TradingModule, MarketDataModule],
  controllers: [StrategiesController, SignalsController, BacktestsController],
  providers: [
    MarketCalendarService,
    StrategyDataService,
    StrategiesService,
    BacktestsService,
    StrategyScheduler,
  ],
})
export class StrategiesModule {}
