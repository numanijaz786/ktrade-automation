/**
 * Alert decision function (pure, decimal-only). The evaluator gathers inputs; this decides.
 *
 * Semantics (all thresholds are decimal strings in `params`, mirrored into `alerts.threshold`):
 *  - PRICE_ABOVE / PRICE_BELOW      last ≥ price / last ≤ price
 *  - PCT_CHANGE_ABOVE / _BELOW      day change% ≥ +pct / ≤ −pct   (pct is a positive magnitude)
 *  - VOLUME_SPIKE                   today's volume ≥ multiple × average D1 volume of the last 20 completed sessions
 *  - PORTFOLIO_DAILY_LOSS           today's P&L ≤ −pct % of the previous close value
 *  - POSITION_STOP_LOSS             last ≤ avgCost × (1 − pct/100), position open
 * Level-triggered with a cooldown: while the condition holds, an alert fires at most once per `cooldownMinutes`;
 * `triggerOnce` alerts fire once and are then deactivated.
 */
import { type Decimal, HUNDRED, ONE } from '@ktrade/finance-core';
import type { AlertType } from '@ktrade/shared';

export const EVALUABLE_ALERT_TYPES = [
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_CHANGE_ABOVE',
  'PCT_CHANGE_BELOW',
  'VOLUME_SPIKE',
  'PORTFOLIO_DAILY_LOSS',
  'POSITION_STOP_LOSS',
] as const satisfies readonly AlertType[];
export type EvaluableAlertType = (typeof EVALUABLE_ALERT_TYPES)[number];

export interface AlertRuleState {
  id: string;
  type: EvaluableAlertType;
  threshold: Decimal;
  isActive: boolean;
  triggerOnce: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
}

export interface AlertInputs {
  last?: Decimal | null;
  changePct?: Decimal | null;
  volume?: Decimal | null;
  avgVolume20d?: Decimal | null;
  /** Today's portfolio P&L as a fraction of the previous close value (−0.03 = −3%). */
  portfolioDailyReturn?: Decimal | null;
  position?: { quantity: Decimal; avgCost: Decimal } | null;
}

export type AlertDecision =
  | { fire: true; observed: string; condition: string }
  | { fire: false; reason: 'INACTIVE' | 'ALREADY_TRIGGERED' | 'COOLDOWN' | 'NO_DATA' | 'CONDITION_NOT_MET' };

const MINUTE_MS = 60_000;

/** True while the alert is inside its cooldown window (or spent, for triggerOnce). */
export function suppressed(alert: AlertRuleState, now: Date): AlertDecision | null {
  if (!alert.isActive) return { fire: false, reason: 'INACTIVE' };
  if (alert.triggerOnce && alert.lastTriggeredAt) return { fire: false, reason: 'ALREADY_TRIGGERED' };
  if (
    alert.lastTriggeredAt &&
    now.getTime() - alert.lastTriggeredAt.getTime() < Math.max(alert.cooldownMinutes, 1) * MINUTE_MS
  ) {
    return { fire: false, reason: 'COOLDOWN' };
  }
  return null;
}

export function decideAlert(alert: AlertRuleState, inputs: AlertInputs, now: Date): AlertDecision {
  const blocked = suppressed(alert, now);
  if (blocked) return blocked;
  const t = alert.threshold;
  const noData = { fire: false, reason: 'NO_DATA' } as const;
  const notMet = { fire: false, reason: 'CONDITION_NOT_MET' } as const;
  switch (alert.type) {
    case 'PRICE_ABOVE':
    case 'PRICE_BELOW': {
      const last = inputs.last;
      if (!last) return noData;
      const hit = alert.type === 'PRICE_ABOVE' ? last.gte(t) : last.lte(t);
      return hit
        ? {
            fire: true,
            observed: last.toFixed(),
            condition: `${alert.type === 'PRICE_ABOVE' ? '≥' : '≤'} ${t.toFixed()}`,
          }
        : notMet;
    }
    case 'PCT_CHANGE_ABOVE':
    case 'PCT_CHANGE_BELOW': {
      const c = inputs.changePct;
      if (!c) return noData;
      const hit = alert.type === 'PCT_CHANGE_ABOVE' ? c.gte(t) : c.lte(t.neg());
      return hit
        ? {
            fire: true,
            observed: `${c.toFixed()}%`,
            condition: alert.type === 'PCT_CHANGE_ABOVE' ? `≥ +${t.toFixed()}%` : `≤ −${t.toFixed()}%`,
          }
        : notMet;
    }
    case 'VOLUME_SPIKE': {
      const v = inputs.volume;
      const avg = inputs.avgVolume20d;
      if (!v || !avg || !avg.gt(0)) return noData;
      return v.gte(avg.times(t))
        ? {
            fire: true,
            observed: `${v.toFixed()} (${v.div(avg).toDecimalPlaces(2).toFixed(2)}× 20-day avg ${avg.toFixed(0)})`,
            condition: `≥ ${t.toFixed()}× avg`,
          }
        : notMet;
    }
    case 'PORTFOLIO_DAILY_LOSS': {
      const r = inputs.portfolioDailyReturn;
      if (!r) return noData;
      const pctNow = r.times(HUNDRED);
      return pctNow.lte(t.neg())
        ? {
            fire: true,
            observed: `${pctNow.toDecimalPlaces(2).toFixed(2)}%`,
            condition: `≤ −${t.toFixed()}%`,
          }
        : notMet;
    }
    case 'POSITION_STOP_LOSS': {
      const pos = inputs.position;
      const last = inputs.last;
      if (!pos || !last || !pos.quantity.gt(0) || !pos.avgCost.gt(0)) return noData;
      const stop = pos.avgCost.times(ONE.minus(t.div(HUNDRED)));
      return last.lte(stop)
        ? {
            fire: true,
            observed: last.toFixed(),
            condition: `≤ ${stop.toDecimalPlaces(4).toFixed()} (avg cost ${pos.avgCost.toFixed()} − ${t.toFixed()}%)`,
          }
        : notMet;
    }
  }
}

/**
 * Idempotency key for a firing. triggerOnce → one key per activation (`activatedAt` = the alert's last config
 * change, so re-enabling an alert re-arms it); otherwise one key per cooldown window, so a retried or concurrent
 * evaluation inside the same window can never produce a second notification (unique index).
 */
export function alertDedupeKey(
  alert: Pick<AlertRuleState, 'id' | 'triggerOnce' | 'cooldownMinutes'> & { activatedAt: Date },
  now: Date,
) {
  if (alert.triggerOnce) return `alert:${alert.id}:once:${alert.activatedAt.getTime()}`;
  const windowMs = Math.max(alert.cooldownMinutes, 1) * MINUTE_MS;
  return `alert:${alert.id}:w${Math.floor(now.getTime() / windowMs)}`;
}
