import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AnnouncementsService } from './announcements.service.js';
import { FinancialsService } from './financials.service.js';
import { MacroService } from './macro.service.js';
import { ResearchProviderRegistry } from './research-provider-registry.js';
import {
  type AnnouncementInput,
  announcementInputSchema,
  announcementsQuerySchema,
  csvBodySchema,
  type FinancialInput,
  financialInputSchema,
  financialsQuerySchema,
  type MacroInput,
  macroInputSchema,
  macroQuerySchema,
  newsFeedQuerySchema,
} from './research-data.schemas.js';

type CsvBody = z.infer<typeof csvBodySchema>;

@ApiTags('research')
@ApiBearerAuth()
@Controller('research')
export class ResearchDataController {
  constructor(
    private readonly financials: FinancialsService,
    private readonly announcements: AnnouncementsService,
    private readonly macro: MacroService,
    private readonly providers: ResearchProviderRegistry,
  ) {}

  // ───────────── fundamentals ─────────────

  @Post('financials')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Record one period of company financials (USER_REPORTED; cite the document)' })
  recordFinancial(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(financialInputSchema)) body: FinancialInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.financials.record(user.id, body, meta);
  }

  @Post('financials/import')
  @Roles('OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Import financials from CSV (symbol,periodType,periodEnd,publishedAt,sourceRef[,currency,sourceUrl,revenue,…]); all-or-nothing with row-level errors',
  })
  importFinancials(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(csvBodySchema)) body: CsvBody,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.financials.importCsv(user.id, body.csv, meta);
  }

  @Get('financials')
  @ApiOperation({ summary: 'Financial periods on file for a symbol (newest first)' })
  listFinancials(
    @Query(new ZodValidationPipe(financialsQuerySchema)) q: z.infer<typeof financialsQuerySchema>,
  ) {
    return this.financials.list(q.symbol, q.periodType, q.limit);
  }

  // ───────────── announcements ─────────────

  @Post('announcements')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Record an announcement / news item (deduplicated; 409 when already recorded)' })
  recordAnnouncement(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(announcementInputSchema)) body: AnnouncementInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.announcements.record(user.id, body, meta);
  }

  @Post('announcements/import')
  @Roles('OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Import announcements from CSV (publishedAt,title[,category,symbol,symbols,url,summary,sourceName,sentiment,relevance])',
  })
  importAnnouncements(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(csvBodySchema)) body: CsvBody,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.announcements.importCsv(user.id, body.csv, meta);
  }

  @Get('announcements')
  @ApiOperation({
    summary: 'Announcements by publish time (newest first), flagged when they touch your holdings',
  })
  listAnnouncements(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(announcementsQuerySchema)) q: z.infer<typeof announcementsQuerySchema>,
  ) {
    return this.announcements.list(user.id, q);
  }

  @Get('news-feed')
  @ApiOperation({ summary: 'Only items inside the freshness window, with lastUpdated and a coverage note' })
  newsFeed(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(newsFeedQuerySchema)) q: z.infer<typeof newsFeedQuerySchema>,
  ) {
    return this.announcements.newsFeed(user.id, q);
  }

  // ───────────── macro ─────────────

  @Post('macro')
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Record a macro observation (one value per series and date; re-posting corrects it)',
  })
  recordMacro(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(macroInputSchema)) body: MacroInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.macro.record(user.id, body, meta);
  }

  @Get('macro')
  listMacro(@Query(new ZodValidationPipe(macroQuerySchema)) q: z.infer<typeof macroQuerySchema>) {
    return this.macro.list(q);
  }

  // ───────────── providers ─────────────

  @Get('providers')
  @ApiOperation({
    summary: 'Research data providers: status, freshness, licence notes and what is missing to enable each',
  })
  async listProviders() {
    return { data: await this.providers.statuses() };
  }
}
