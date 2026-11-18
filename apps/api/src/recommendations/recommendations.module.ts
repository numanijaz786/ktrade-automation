import { Module } from '@nestjs/common';
import { OutcomeEvaluator } from './outcome-evaluator.service.js';
import { RecommendationsController } from './recommendations.controller.js';
import { RecommendationsStore } from './recommendations.store.js';

/**
 * Append-only recommendation ledger + outcome tracking (docs/10 §3). The engine itself lives in finance-core;
 * this module only stores what it produced and measures how it turned out. Prisma, Audit and Clock are global.
 */
@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsStore, OutcomeEvaluator],
  exports: [RecommendationsStore, OutcomeEvaluator],
})
export class RecommendationsModule {}
