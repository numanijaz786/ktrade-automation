/**
 * Alert types, their typed params and client-side validation — mirrors apps/api/src/alerts/alerts.schemas.ts.
 * The API validates again (422); this only gives early, per-field feedback. Decimals stay strings: every
 * numeric comparison first checks DECIMAL_STRING_RE (ADR-024 — Zod 4 runs refinements after a failed regex).
 */
import { z } from 'zod';
import { DECIMAL_STRING_RE, type NotificationChannel } from '@ktrade/shared';
import { Dec } from './decimal';
import { formatNumber } from './format';
import { ALERT_KINDS, type Alert, type AlertInput, type AlertKind } from './api/types';

export { ALERT_KINDS };

export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
export const MAX_COOLDOWN_MINUTES = 10_080;
/** Only the in-app channel is delivered today; the others are disabled server-side (ADR-027). */
export const ENABLED_CHANNELS: readonly NotificationChannel[] = ['IN_APP'];
export const ALL_CHANNELS: readonly NotificationChannel[] = ['IN_APP', 'EMAIL', 'TELEGRAM'];

const isDec = (v: string) => DECIMAL_STRING_RE.test(v);
const decimal = z.string().trim().regex(DECIMAL_STRING_RE, 'Enter a number, e.g. 150.50');
const positive = decimal.refine((v) => !isDec(v) || (!v.startsWith('-') && /[1-9]/.test(v)), {
  message: 'Must be greater than zero',
});
const pctBelow100 = positive.refine((v) => !isDec(v) || Dec.of(v).lt(100), { message: 'Must be below 100' });
const upTo1000 = positive.refine((v) => !isDec(v) || Dec.of(v).lte(1000), {
  message: 'Must be at most 1000',
});

export type ParamKey = 'price' | 'pct' | 'multiple';
type Target = 'symbol' | 'portfolio' | 'both';

export interface AlertMeta {
  label: string;
  description: string;
  target: Target;
  paramKey: ParamKey;
  paramLabel: string;
  schema: z.ZodType<string>;
  /** Human condition, e.g. "Price ≥ Rs 150". */
  condition: (value: string) => string;
}

export const ALERT_META: Record<AlertKind, AlertMeta> = {
  PRICE_ABOVE: {
    label: 'Price above',
    description: 'Last price rises to or above a level.',
    target: 'symbol',
    paramKey: 'price',
    paramLabel: 'Price (Rs)',
    schema: positive,
    condition: (v) => `Price ≥ Rs ${formatNumber(v)}`,
  },
  PRICE_BELOW: {
    label: 'Price below',
    description: 'Last price falls to or below a level.',
    target: 'symbol',
    paramKey: 'price',
    paramLabel: 'Price (Rs)',
    schema: positive,
    condition: (v) => `Price ≤ Rs ${formatNumber(v)}`,
  },
  PCT_CHANGE_ABOVE: {
    label: 'Day change up',
    description: 'Change vs previous close is at least +X%.',
    target: 'symbol',
    paramKey: 'pct',
    paramLabel: 'Change (%)',
    schema: upTo1000,
    condition: (v) => `Day change ≥ +${v}%`,
  },
  PCT_CHANGE_BELOW: {
    label: 'Day change down',
    description: 'Change vs previous close is at most −X%.',
    target: 'symbol',
    paramKey: 'pct',
    paramLabel: 'Drop (%)',
    schema: pctBelow100,
    condition: (v) => `Day change ≤ −${v}%`,
  },
  VOLUME_SPIKE: {
    label: 'Volume spike',
    description: 'Today’s volume is at least N × the 20-day average.',
    target: 'symbol',
    paramKey: 'multiple',
    paramLabel: 'Multiple of 20-day avg volume',
    schema: upTo1000,
    condition: (v) => `Volume ≥ ${v}× 20-day avg`,
  },
  PORTFOLIO_DAILY_LOSS: {
    label: 'Portfolio daily loss',
    description: 'Today’s portfolio return is at most −X% (live vs previous close snapshot).',
    target: 'portfolio',
    paramKey: 'pct',
    paramLabel: 'Loss (%)',
    schema: pctBelow100,
    condition: (v) => `Today’s return ≤ −${v}%`,
  },
  POSITION_STOP_LOSS: {
    label: 'Position stop-loss',
    description: 'Price falls X% below your average cost of a holding.',
    target: 'both',
    paramKey: 'pct',
    paramLabel: 'Below average cost (%)',
    schema: pctBelow100,
    condition: (v) => `Price ≤ avg cost − ${v}%`,
  },
};

export const needsSymbol = (t: AlertKind) => ALERT_META[t].target !== 'portfolio';
export const needsPortfolio = (t: AlertKind) => ALERT_META[t].target !== 'symbol';

/** Human condition of a stored alert. */
export function describeAlert(a: Pick<Alert, 'type' | 'params'>): string {
  const meta = ALERT_META[a.type];
  const v = a.params[meta.paramKey];
  return v === undefined ? meta.label : meta.condition(v);
}

export interface AlertFormValues {
  type: AlertKind;
  symbol: string;
  portfolioId: string;
  value: string;
  cooldownMinutes: string;
  triggerOnce: boolean;
  active: boolean;
  channels: NotificationChannel[];
}

export const alertFormSchema = z
  .object({
    type: z.enum(ALERT_KINDS),
    symbol: z.string(),
    portfolioId: z.string(),
    value: z.string(),
    cooldownMinutes: z.string(),
    triggerOnce: z.boolean(),
    active: z.boolean(),
    channels: z.array(z.enum(['IN_APP', 'EMAIL', 'TELEGRAM'])),
  })
  .superRefine((v, ctx) => {
    const meta = ALERT_META[v.type];
    const param = meta.schema.safeParse(v.value);
    if (!param.success)
      ctx.addIssue({ code: 'custom', path: ['value'], message: param.error.issues[0]?.message ?? 'Invalid' });
    if (needsSymbol(v.type) && !SYMBOL_RE.test(v.symbol.trim().toUpperCase()))
      ctx.addIssue({ code: 'custom', path: ['symbol'], message: 'Enter a PSX symbol, e.g. OGDC' });
    if (needsPortfolio(v.type) && !v.portfolioId)
      ctx.addIssue({ code: 'custom', path: ['portfolioId'], message: 'Pick a portfolio' });
    const cd = v.cooldownMinutes.trim();
    if (!/^\d{1,5}$/.test(cd) || Number(cd) < 1 || Number(cd) > MAX_COOLDOWN_MINUTES)
      ctx.addIssue({
        code: 'custom',
        path: ['cooldownMinutes'],
        message: `Whole minutes from 1 to ${MAX_COOLDOWN_MINUTES}`,
      });
    if (v.channels.length === 0)
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'Pick at least one channel' });
  });

export type AlertFormResult =
  { ok: true; input: AlertInput } | { ok: false; errors: Partial<Record<keyof AlertFormValues, string>> };

/** Validate the form and build the API input (symbol upper-cased, params keyed per type). */
export function validateAlertForm(values: AlertFormValues): AlertFormResult {
  const r = alertFormSchema.safeParse(values);
  if (!r.success) {
    const errors: Partial<Record<keyof AlertFormValues, string>> = {};
    for (const issue of r.error.issues) {
      const key = issue.path[0] as keyof AlertFormValues;
      if (key && !errors[key]) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  const v = r.data;
  const meta = ALERT_META[v.type];
  return {
    ok: true,
    input: {
      type: v.type,
      ...(needsSymbol(v.type) ? { symbol: v.symbol.trim().toUpperCase() } : {}),
      ...(needsPortfolio(v.type) ? { portfolioId: v.portfolioId } : {}),
      params: { [meta.paramKey]: v.value.trim() },
      channels: [...new Set(v.channels)],
      cooldownMinutes: Number(v.cooldownMinutes.trim()),
      triggerOnce: v.triggerOnce,
      active: v.active,
    },
  };
}
