import { Injectable } from '@nestjs/common';
import type { ImportKind } from '@ktrade/shared';
import { GenericTransactionsCsvParser } from './generic-csv.parser.js';
import type { StatementParser } from './parser.types.js';

/**
 * All statement parsers. Add KTrade contract-note / ledger / CDC parsers here once real (redacted) samples exist
 * — they must ship with golden-file tests and declare source BROKER_CONFIRMED.
 */
@Injectable()
export class ParserRegistry {
  private readonly parsers: readonly StatementParser[] = [new GenericTransactionsCsvParser()];

  /** Explicit kind wins; otherwise the most confident detector (≥ 0.5). */
  resolve(fileName: string, content: string, kind?: ImportKind): StatementParser | null {
    if (kind) return this.parsers.find((p) => p.kind === kind) ?? null;
    const ranked = this.parsers
      .map((p) => ({ p, score: p.detect(fileName, content) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.p ?? null;
  }

  byKey(key: string): StatementParser | null {
    return this.parsers.find((p) => p.key === key) ?? null;
  }

  supportedKinds(): ImportKind[] {
    return [...new Set(this.parsers.map((p) => p.kind))];
  }
}
