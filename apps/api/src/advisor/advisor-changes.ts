import { type Decimal, type ResearchBar } from '@ktrade/finance-core';
import { fromDb } from '../market-data/decimal-format.js';
import { pktDateOf } from '../market-data/calendar.js';
import { num } from './advisor.views.js';

export type ChangeKind =
  | 'ACTION_CHANGED'
  | 'NEWLY_ACTIONABLE'
  | 'BECAME_NOT_ACTIONABLE'
  | 'ENTERED_ENTRY_RANGE'
  | 'TARGET_HIT'
  | 'STOP_HIT';

export interface ChangeEvent {
  kind: ChangeKind;
  symbol: string;
  horizon: string;
  /** Stored recommendation the change is measured against. */
  baselineId: string;
  baselineAsOfBar: string;
  from: string | null;
  to: string | null;
  targetN?: 1 | 2 | 3;
  date?: string;
  detail: string;
}

export interface RecInfo {
  id: string;
  symbol: string;
  horizon: string;
  asOfBar: string;
  engineStatus: 'ACTIONABLE' | 'NOT_ACTIONABLE';
  engineAction: string | null;
  entryLow: Decimal | null;
  entryHigh: Decimal | null;
  stop: Decimal | null;
  targets: readonly (Decimal | null)[];
}

interface RowLike {
  id: string;
  horizon: string;
  action: string;
  status: string;
  asOfBar: Date;
  entryLow: { toFixed(): string } | null;
  entryHigh: { toFixed(): string } | null;
  stop: { toFixed(): string } | null;
  target1: { toFixed(): string } | null;
  target2: { toFixed(): string } | null;
  target3: { toFixed(): string } | null;
  components: unknown;
  stock: { symbol: string };
}

const dn = (v: { toFixed(): string } | null): Decimal | null => (v === null ? null : fromDb(v));

/** Engine-level status/action live in `components` (the DB status column only marks trade ideas with levels). */
export function recInfo(r: RowLike): RecInfo {
  const c = (r.components ?? {}) as { engineStatus?: string; engineAction?: string | null };
  const engineStatus =
    c.engineStatus === 'ACTIONABLE' || c.engineStatus === 'NOT_ACTIONABLE'
      ? c.engineStatus
      : (r.status as 'ACTIONABLE' | 'NOT_ACTIONABLE');
  const engineAction =
    c.engineAction !== undefined ? c.engineAction : engineStatus === 'ACTIONABLE' ? r.action : null;
  return {
    id: r.id,
    symbol: r.stock.symbol,
    horizon: r.horizon,
    asOfBar: r.asOfBar.toISOString().slice(0, 10),
    engineStatus,
    engineAction,
    entryLow: dn(r.entryLow),
    entryHigh: dn(r.entryHigh),
    stop: dn(r.stop),
    targets: [dn(r.target1), dn(r.target2), dn(r.target3)],
  };
}

export interface CurrentState {
  engineStatus: 'ACTIONABLE' | 'NOT_ACTIONABLE';
  engineAction: string | null;
  reason?: string;
}

/** Differences between a stored baseline recommendation and the current state, using only completed bars after the baseline bar. */
export function diffRecommendation(
  prev: RecInfo,
  cur: CurrentState,
  bars: readonly ResearchBar[],
): ChangeEvent[] {
  const base = {
    symbol: prev.symbol,
    horizon: prev.horizon,
    baselineId: prev.id,
    baselineAsOfBar: prev.asOfBar,
  };
  const out: ChangeEvent[] = [];
  if (prev.engineStatus === 'NOT_ACTIONABLE' && cur.engineStatus === 'ACTIONABLE') {
    out.push({
      ...base,
      kind: 'NEWLY_ACTIONABLE',
      from: null,
      to: cur.engineAction,
      detail: `now evaluable: ${cur.engineAction}`,
    });
  } else if (prev.engineStatus === 'ACTIONABLE' && cur.engineStatus === 'NOT_ACTIONABLE') {
    out.push({
      ...base,
      kind: 'BECAME_NOT_ACTIONABLE',
      from: prev.engineAction,
      to: null,
      detail: cur.reason ?? 'no longer evaluable',
    });
  } else if (prev.engineStatus === 'ACTIONABLE' && cur.engineAction !== prev.engineAction) {
    out.push({
      ...base,
      kind: 'ACTION_CHANGED',
      from: prev.engineAction,
      to: cur.engineAction,
      detail: `${prev.engineAction} to ${cur.engineAction}`,
    });
  }
  if (prev.stop !== null) {
    const later = bars.filter((b) => pktDateOf(new Date(b.ts)) > prev.asOfBar);
    const stopBar = later.find((b) => b.low.lte(prev.stop as Decimal));
    if (stopBar)
      out.push({
        ...base,
        kind: 'STOP_HIT',
        from: null,
        to: null,
        date: pktDateOf(new Date(stopBar.ts)),
        detail: `low ${num(stopBar.low)} reached the stop ${num(prev.stop)}`,
      });
    prev.targets.forEach((t, i) => {
      if (t === null) return;
      const hit = later.find((b) => b.high.gte(t));
      if (hit)
        out.push({
          ...base,
          kind: 'TARGET_HIT',
          from: null,
          to: null,
          targetN: (i + 1) as 1 | 2 | 3,
          date: pktDateOf(new Date(hit.ts)),
          detail: `high ${num(hit.high)} reached Target ${i + 1} at ${num(t)}`,
        });
    });
    const last = bars.at(-1);
    const before = bars.at(-2);
    if (!stopBar && prev.entryLow && prev.entryHigh && last && before && later.length > 0) {
      const inRange = (c: Decimal) => c.gte(prev.entryLow as Decimal) && c.lte(prev.entryHigh as Decimal);
      if (inRange(last.close) && !inRange(before.close))
        out.push({
          ...base,
          kind: 'ENTERED_ENTRY_RANGE',
          from: null,
          to: null,
          date: pktDateOf(new Date(last.ts)),
          detail: `close ${num(last.close)} is inside the entry range ${num(prev.entryLow)} to ${num(prev.entryHigh)}`,
        });
    }
  }
  return out;
}
