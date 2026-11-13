import type { DataSource } from './enums.js';

/** A value with provenance. Every financial figure exposed by the API is wrapped like this. */
export interface Sourced<T> {
  value: T;
  source: DataSource;
  /** ISO-8601 instant the value refers to (price time, statement date, …). */
  asOf?: string;
}
