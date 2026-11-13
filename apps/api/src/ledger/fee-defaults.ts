/**
 * Effective date of KTrade's published fee schedule (Commission Structure PDF) used as the default.
 * Dependency-free on purpose: importable by scripts (seed) without loading Nest config (see ADR-019 lesson).
 */
export const DEFAULT_SCHEDULE_EFFECTIVE_FROM = '2025-01-01';
