import { Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SIM_BASE_PRICES } from '../seed/stocks.js';
import { MarketCalendarService } from './market-calendar.service.js';
import { MarketDataController, WatchlistsController } from './market-data.controller.js';
import { MarketDataService } from './market-data.service.js';
import { MarketDataProviderRegistry } from './provider-registry.js';
import { CapitalStakeProvider } from './providers/capital-stake.provider.js';
import { CsvEodProvider } from './providers/csv-eod.provider.js';
import { SimulatedMarketDataProvider } from './providers/simulated.provider.js';
import { WatchlistsService } from './watchlists.service.js';

export const TICKER_INTERVAL_MS = 15_000;

/** Keeps `stock_quotes` fresh in the background when MARKET_DATA_TICKER=true (otherwise quotes refresh on read). */
@Injectable()
export class QuoteTicker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QuoteTicker');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly market: MarketDataService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('MARKET_DATA_TICKER')) return;
    this.timer = setInterval(() => void this.market.refreshQuotes(), TICKER_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Quote ticker every ${TICKER_INTERVAL_MS / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  controllers: [MarketDataController, WatchlistsController],
  providers: [
    MarketCalendarService,
    {
      provide: SimulatedMarketDataProvider,
      inject: [CLOCK, MarketCalendarService],
      useFactory: (clock: Clock, cal: MarketCalendarService) =>
        new SimulatedMarketDataProvider(clock, () => cal.current(), SIM_BASE_PRICES),
    },
    {
      provide: CsvEodProvider,
      inject: [PrismaService, CLOCK, MarketCalendarService],
      useFactory: (prisma: PrismaService, clock: Clock, cal: MarketCalendarService) =>
        new CsvEodProvider(prisma, clock, () => cal.current()),
    },
    {
      provide: CapitalStakeProvider,
      inject: [CLOCK],
      useFactory: (clock: Clock) => new CapitalStakeProvider(clock),
    },
    MarketDataProviderRegistry,
    MarketDataService,
    WatchlistsService,
    QuoteTicker,
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
