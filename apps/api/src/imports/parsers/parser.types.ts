import type { DataSource, FeeComponent, ImportKind, OrderSide } from '@ktrade/shared';

/** One normalised trade row produced by any statement parser. Decimals are strings. */
export interface ParsedTradeRow {
  rowIndex: number;
  raw: Record<string, string>;
  /** Present when the row is valid. */
  trade?: {
    tradeDate: string; // YYYY-MM-DD
    symbol: string;
    side: OrderSide;
    quantity: string;
    price: string;
    /** Broker-stated charges; when absent the fee engine estimates them (ESTIMATED). */
    fees: { component: FeeComponent; amount: string }[];
    externalRef?: string;
  };
  errors: string[];
}

/**
 * A statement parser. Register new ones (e.g. `ktrade.contract-note.pdf`) in parser-registry.ts.
 * `source` is the provenance of rows it produces: broker-generated documents → BROKER_CONFIRMED;
 * user-assembled files → USER_REPORTED.
 */
export interface StatementParser {
  readonly key: string;
  readonly version: string;
  readonly kind: ImportKind;
  readonly source: DataSource;
  /** 0..1 confidence that this parser understands the file. */
  detect(fileName: string, content: string): number;
  parse(content: string): ParsedTradeRow[];
}
