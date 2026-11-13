import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { PRICE_INTERVALS } from '@ktrade/shared';
import {
  type AuthUser,
  CurrentUser,
  ReqMeta,
  type RequestMeta,
  RequireStepUp,
  Roles,
} from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SYMBOL_RE } from './decimal-format.js';
import { MarketDataService } from './market-data.service.js';
import { MOVER_TYPES } from './movers.js';
import { WatchlistsService } from './watchlists.service.js';

const symbol = z.string().trim().toUpperCase().regex(SYMBOL_RE, 'invalid symbol');
const isoDate = z.string().date();
const stocksQuery = z.object({
  search: z.string().trim().max(60).optional(),
  sector: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const quotesQuery = z.object({
  symbols: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(symbol).max(200).optional()),
});
const candlesQuery = z.object({
  interval: z.enum(PRICE_INTERVALS).default('D1'),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const moversQuery = z.object({
  type: z.enum(MOVER_TYPES).default('gainers'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const providerBody = z.object({ key: z.string().trim().min(1).max(40) });
const importBody = z.object({
  csv: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
});
const watchlistName = z.string().trim().min(1).max(60);
const createWatchlist = z.object({ name: watchlistName, symbols: z.array(symbol).max(100).default([]) });
const renameWatchlist = z.object({ name: watchlistName });
const addStock = z.object({ symbol });

@ApiTags('market')
@ApiBearerAuth()
@Controller('market')
export class MarketDataController {
  constructor(private readonly market: MarketDataService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Session status, breadth, movers, sectors — with data source and timestamp' })
  overview() {
    return this.market.overview();
  }

  @Get('providers')
  providers() {
    return this.market.providers();
  }

  @Put('providers/active')
  @Roles('OWNER')
  @RequireStepUp()
  @ApiOperation({ summary: '🔐 Switch the active provider (only enabled providers)' })
  setProvider(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(providerBody)) b: z.infer<typeof providerBody>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.market.setActiveProvider(user.id, b.key, meta);
  }

  @Get('stocks')
  stocks(@Query(new ZodValidationPipe(stocksQuery)) q: z.infer<typeof stocksQuery>) {
    return this.market.stocks(q);
  }

  @Get('stocks/:symbol')
  stock(@Param('symbol', new ZodValidationPipe(symbol)) s: string) {
    return this.market.stock(s);
  }

  @Get('sectors')
  sectors() {
    return this.market.sectors();
  }

  @Get('quotes')
  quotes(@Query(new ZodValidationPipe(quotesQuery)) q: z.infer<typeof quotesQuery>) {
    return this.market.quotes(q.symbols);
  }

  @Get('candles/:symbol')
  candles(
    @Param('symbol', new ZodValidationPipe(symbol)) s: string,
    @Query(new ZodValidationPipe(candlesQuery)) q: z.infer<typeof candlesQuery>,
  ) {
    return this.market.candles(s, q.interval, q.from, q.to);
  }

  @Get('movers')
  movers(@Query(new ZodValidationPipe(moversQuery)) q: z.infer<typeof moversQuery>) {
    return this.market.movers(q.type, q.limit);
  }

  @Post('prices/import')
  @Roles('OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Import EOD prices you hold rights to (CSV: symbol,date,open,high,low,close,volume) — labelled USER_REPORTED',
  })
  importPrices(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(importBody)) b: z.infer<typeof importBody>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.market.importPrices(user.id, b.csv, meta);
  }
}

@ApiTags('watchlists')
@ApiBearerAuth()
@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly watchlists: WatchlistsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.watchlists.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.watchlists.get(user.id, id);
  }

  @Post()
  @Roles('OWNER')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createWatchlist)) b: z.infer<typeof createWatchlist>,
  ) {
    return this.watchlists.create(user.id, b.name, b.symbols);
  }

  @Patch(':id')
  @Roles('OWNER')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(renameWatchlist)) b: z.infer<typeof renameWatchlist>,
  ) {
    return this.watchlists.rename(user.id, id, b.name);
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.watchlists.remove(user.id, id);
  }

  @Post(':id/stocks')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  addStock(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addStock)) b: z.infer<typeof addStock>,
  ) {
    return this.watchlists.addStock(user.id, id, b.symbol);
  }

  @Delete(':id/stocks/:symbol')
  @Roles('OWNER')
  removeStock(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('symbol', new ZodValidationPipe(symbol)) s: string,
  ) {
    return this.watchlists.removeStock(user.id, id, s);
  }
}
