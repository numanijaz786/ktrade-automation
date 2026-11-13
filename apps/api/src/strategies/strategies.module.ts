import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { TradingModule } from '../trading/trading.module.js';
import { BacktestsService } from './backtests.service.js';
import { BacktestsController, SignalsController, StrategiesController } from './strategies.controller.js';
import { StrategiesService } from './strategies.service.js';
import { StrategyDataService } from './strategy-data.service.js';

/**
 * Strategies, signals and backtests (Phase 9, docs/08). Orders go through TradingModule's pipeline only;
 * this module never writes orders or the ledger directly.
 */
@Module({
  imports: [AuthModule, TradingModule, MarketDataModule],
  controllers: [StrategiesController, SignalsController, BacktestsController],
  providers: [StrategyDataService, StrategiesService, BacktestsService],
})
export class StrategiesModule {}
