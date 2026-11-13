import { Module } from '@nestjs/common';
import { FeeService } from '../ledger/fee.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PortfolioController } from '../portfolio/portfolio.controller.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import { TradingController } from './trading.controller.js';
import { TradingService } from './trading.service.js';

/** Ledger + portfolio + order pipeline. LedgerService is the only writer of trades. */
@Module({
  controllers: [PortfolioController, TradingController],
  providers: [LedgerService, FeeService, PortfolioService, TradingService],
  exports: [LedgerService, FeeService, PortfolioService, TradingService],
})
export class TradingModule {}
