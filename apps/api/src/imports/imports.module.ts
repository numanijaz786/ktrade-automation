import { Module } from '@nestjs/common';
import { BrokerAccountsService } from '../broker/broker-accounts.service.js';
import { BrokerController } from '../broker/broker.controller.js';
import { TradingModule } from '../trading/trading.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';
import { ParserRegistry } from './parsers/parser-registry.js';

/** Broker accounts + statement import pipeline. Posts to the ledger via TradingModule's LedgerService. */
@Module({
  imports: [TradingModule],
  controllers: [BrokerController, ImportsController],
  providers: [BrokerAccountsService, ImportsService, ParserRegistry],
})
export class ImportsModule {}
