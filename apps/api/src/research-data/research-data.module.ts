import { Module } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service.js';
import { FinancialsService } from './financials.service.js';
import { MacroService } from './macro.service.js';
import { ResearchDataController } from './research-data.controller.js';
import { ResearchProviderRegistry } from './research-provider-registry.js';

/**
 * Research data layer (docs/10): owner-entered fundamentals, announcements and macro series plus a provider
 * registry whose licensed adapters are disabled stubs. No scraping, no network calls, no invented data.
 * Prisma, Audit and Clock come from global modules.
 */
@Module({
  controllers: [ResearchDataController],
  providers: [FinancialsService, AnnouncementsService, MacroService, ResearchProviderRegistry],
  exports: [ResearchProviderRegistry],
})
export class ResearchDataModule {}
