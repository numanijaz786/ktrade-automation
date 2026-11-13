import { describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import { type AlertRuleState, alertDedupeKey, decideAlert, type EvaluableAlertType } from './alert-rules.js';

const NOW = new Date('2026-11-16T06:00:00Z');
const alert = (
  type: EvaluableAlertType,
  threshold: string,
  extra: Partial<AlertRuleState> = {},
): AlertRuleState => ({
  id: 'a1',
  type,
  threshold: d(threshold),
  isActive: true,
  triggerOnce: false,
  cooldownMinutes: 60,
  lastTriggeredAt: null,
  ...extra,
});
const fires = (a: AlertRuleState, inputs: Parameters<typeof decideAlert>[1]) =>
  decideAlert(a, inputs, NOW).fire;

describe('decideAlert — each type', () => {
  it('PRICE_ABOVE / PRICE_BELOW are inclusive', () => {
    expect(fires(alert('PRICE_ABOVE', '150'), { last: d('150') })).toBe(true);
    expect(fires(alert('PRICE_ABOVE', '150'), { last: d('149.99') })).toBe(false);
    expect(fires(alert('PRICE_BELOW', '150'), { last: d('150') })).toBe(true);
    expect(fires(alert('PRICE_BELOW', '150'), { last: d('150.01') })).toBe(false);
    expect(decideAlert(alert('PRICE_ABOVE', '1'), {}, NOW)).toEqual({ fire: false, reason: 'NO_DATA' });
  });

  it('PCT_CHANGE thresholds are magnitudes', () => {
    expect(fires(alert('PCT_CHANGE_ABOVE', '5'), { changePct: d('5.00') })).toBe(true);
    expect(fires(alert('PCT_CHANGE_ABOVE', '5'), { changePct: d('-6') })).toBe(false);
    expect(fires(alert('PCT_CHANGE_BELOW', '5'), { changePct: d('-5.01') })).toBe(true);
    expect(fires(alert('PCT_CHANGE_BELOW', '5'), { changePct: d('-4.99') })).toBe(false);
  });

  it('VOLUME_SPIKE compares with a multiple of the 20-day average', () => {
    expect(fires(alert('VOLUME_SPIKE', '3'), { volume: d('300000'), avgVolume20d: d('100000') })).toBe(true);
    expect(fires(alert('VOLUME_SPIKE', '3'), { volume: d('299999'), avgVolume20d: d('100000') })).toBe(false);
    expect(fires(alert('VOLUME_SPIKE', '3'), { volume: d('1'), avgVolume20d: d('0') })).toBe(false); // no history
  });

  it('PORTFOLIO_DAILY_LOSS fires at a loss of at least pct of the previous close', () => {
    expect(fires(alert('PORTFOLIO_DAILY_LOSS', '2'), { portfolioDailyReturn: d('-0.02') })).toBe(true);
    expect(fires(alert('PORTFOLIO_DAILY_LOSS', '2'), { portfolioDailyReturn: d('-0.0199') })).toBe(false);
    expect(fires(alert('PORTFOLIO_DAILY_LOSS', '2'), { portfolioDailyReturn: null })).toBe(false);
  });

  it('POSITION_STOP_LOSS fires at avgCost × (1 − pct) and only for an open position', () => {
    const pos = { quantity: d('100'), avgCost: d('200') };
    expect(fires(alert('POSITION_STOP_LOSS', '10'), { last: d('180'), position: pos })).toBe(true);
    expect(fires(alert('POSITION_STOP_LOSS', '10'), { last: d('180.01'), position: pos })).toBe(false);
    expect(
      fires(alert('POSITION_STOP_LOSS', '10'), {
        last: d('1'),
        position: { quantity: d('0'), avgCost: d('200') },
      }),
    ).toBe(false);
  });
});

describe('cooldown, triggerOnce, no double-fire', () => {
  it('cooldown suppresses until it has fully elapsed', () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    expect(
      decideAlert(alert('PRICE_ABOVE', '1', { lastTriggeredAt: at(59) }), { last: d('2') }, NOW),
    ).toEqual({
      fire: false,
      reason: 'COOLDOWN',
    });
    expect(fires(alert('PRICE_ABOVE', '1', { lastTriggeredAt: at(60) }), { last: d('2') })).toBe(true);
  });

  it('triggerOnce never fires again; inactive alerts never fire', () => {
    const spent = alert('PRICE_ABOVE', '1', {
      triggerOnce: true,
      lastTriggeredAt: new Date(0),
      cooldownMinutes: 1,
    });
    expect(decideAlert(spent, { last: d('2') }, NOW)).toEqual({ fire: false, reason: 'ALREADY_TRIGGERED' });
    expect(decideAlert(alert('PRICE_ABOVE', '1', { isActive: false }), { last: d('2') }, NOW)).toEqual({
      fire: false,
      reason: 'INACTIVE',
    });
  });

  it('dedupe key is stable within a cooldown window and differs across windows / activations', () => {
    const a = { id: 'a1', triggerOnce: false, cooldownMinutes: 60, activatedAt: new Date(0) };
    const k = alertDedupeKey(a, NOW);
    expect(alertDedupeKey(a, new Date(NOW.getTime() + 59_000))).toBe(k); // a retry a minute later
    expect(alertDedupeKey(a, new Date(NOW.getTime() + 60 * 60_000))).not.toBe(k);
    const once = { ...a, triggerOnce: true };
    expect(alertDedupeKey(once, NOW)).toBe(alertDedupeKey(once, new Date(NOW.getTime() + 86_400_000)));
    expect(alertDedupeKey({ ...once, activatedAt: new Date(1) }, NOW)).not.toBe(alertDedupeKey(once, NOW));
  });
});
