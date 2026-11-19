import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AdvisorDataService } from './advisor-data.service.js';
import {
  type AdvisorSettingsInput,
  advisorSettingsSchema,
  type DailyReportQuery,
  dailyReportQuerySchema,
  type HoldingsQuery,
  holdingsQuerySchema,
  type RunAdvisorInput,
  runAdvisorSchema,
  type ScannerQuery,
  scannerQuerySchema,
  type StockQuery,
  stockQuerySchema,
  symbolSchema,
} from './advisor.schemas.js';
import { AdvisorService } from './advisor.service.js';

@ApiTags('advisor')
@ApiBearerAuth()
@Controller('advisor')
export class AdvisorController {
  constructor(
    private readonly advisor: AdvisorService,
    private readonly data: AdvisorDataService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Advisor settings (risk per trade %)' })
  settings(@CurrentUser() user: AuthUser) {
    return this.data.getSettings(user.id);
  }

  @Put('settings')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Set the risk per trade % used to size ideas (max 5)' })
  setSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(advisorSettingsSchema)) body: AdvisorSettingsInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.data.setSettings(user.id, body.riskPerTradePct, meta);
  }

  @Post('run')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Evaluate the universe per horizon and store every result (idempotent per bar and engine version)',
  })
  run(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(runAdvisorSchema)) body: RunAdvisorInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.advisor.run(user.id, body, 'USER', meta);
  }

  @Get('daily-report')
  @ApiOperation({ summary: 'Daily advisor report built from stored verified data' })
  dailyReport(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(dailyReportQuerySchema)) q: DailyReportQuery,
  ) {
    return this.advisor.dailyReport(user.id, q);
  }

  @Get('holdings')
  @ApiOperation({ summary: 'Per-holding advice with fees-aware P&L' })
  holdings(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(holdingsQuerySchema)) q: HoldingsQuery,
  ) {
    return this.advisor.holdings(user.id, q);
  }

  @Get('scanner')
  @ApiOperation({ summary: 'Ranked scan (max 20) on verified data; may be empty' })
  scanner(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(scannerQuerySchema)) q: ScannerQuery) {
    return this.advisor.scanner(user.id, q);
  }

  @Get('stocks/:symbol')
  @ApiOperation({ summary: 'Full research report for one stock' })
  stock(
    @CurrentUser() user: AuthUser,
    @Param('symbol', new ZodValidationPipe(symbolSchema)) symbol: string,
    @Query(new ZodValidationPipe(stockQuerySchema)) q: StockQuery,
  ) {
    return this.advisor.stockReport(user.id, symbol, q);
  }
}
