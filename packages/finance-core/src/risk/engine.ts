/**
 * Pure pre-trade risk engine (docs/08 §7). Every rule is evaluated (no short-circuit) so the full result set
 * can be stored in order_risk_checks. The order passes only if ALL rules pass.
 *
 * Conventions:
 *  - order value (notional) = qty × price, where price = limitPrice for priced orders, else refPrice (last).
 *    It excludes fees; BUYING_POWER uses `estimatedTotal` (incl. fees) instead.
 *  - A limit set to null/undefined means "not configured" → the rule passes with message "no limit configured".
 *  - All percentages are in percent units (5 = 5%).
 */
import { type Decimal, pct } from '../decimal.js';
import { type TradeOrderType, type TradeSide, type TradingMode } from '../strategy/types.js';

export const RISK_RULES = [
  'KILL_SWITCH',
  'CAPABILITY',
  'MARKET_HOURS',
  'BUYING_POWER',
  'HOLDING_QTY',
  'MAX_ORDER_VALUE',
  'MAX_ORDER_QTY',
  'PRICE_BAND',
  'DAILY_VALUE',
  'DAILY_COUNT',
  'CONCENTRATION',
  'DAILY_LOSS',
  'MARKET_ORDERS_ALLOWED',
  'PRICE_SOURCE',
] as const;
export type RiskRule = (typeof RISK_RULES)[number];

export interface RiskOrderInput {
  readonly side: TradeSide;
  readonly type: TradeOrderType;
  /** Whole shares, > 0. */
  readonly qty: Decimal;
  readonly limitPrice?: Decimal | null;
  readonly stopPrice?: Decimal | null;
  /** Reference (last traded) price. */
  readonly refPrice: Decimal;
  /** BUY: gross value + fees (cash needed). SELL: informational. */
  readonly estimatedTotal: Decimal;
}

export interface RiskPortfolioContext {
  readonly cash: Decimal;
  readonly pendingBuyValue: Decimal;
  readonly heldQty: Decimal;
  readonly pendingSellQty: Decimal;
  /** Current market value of the position in this symbol. */
  readonly positionValue: Decimal;
  readonly portfolioValue: Decimal;
  readonly todayTradedValue: Decimal;
  readonly todayOrderCount: number;
  /** Today's portfolio P&L in percent (negative = loss). */
  readonly todayPnlPct: Decimal;
}

export interface RiskLimits {
  readonly maxOrderValue?: Decimal | null;
  readonly maxOrderQty?: Decimal | null;
  readonly maxDailyTradedValue?: Decimal | null;
  readonly maxDailyOrders?: number | null;
  readonly maxPositionPct?: Decimal | null;
  readonly priceBandPct?: Decimal | null;
  readonly maxDailyLossPct?: Decimal | null;
  readonly allowMarketOrders: boolean;
}

export interface RiskFlags {
  readonly mode: TradingMode;
  /** Global `trading.live.enabled` — true means live trading is ENABLED. */
  readonly killSwitchOn: boolean;
  /** Adapter capability chain implemented ∧ verified ∧ authorized ∧ enabled. */
  readonly capabilityUsable: boolean;
  readonly marketOpen: boolean;
  readonly priceIsSimulated: boolean;
  readonly priceIsStale: boolean;
}

export interface RiskCheckResult {
  readonly rule: RiskRule;
  readonly passed: boolean;
  readonly observed: string | null;
  readonly limit: string | null;
  readonly message: string;
}

export interface RiskEvaluation {
  readonly passed: boolean;
  readonly results: readonly RiskCheckResult[];
  /** Rules that failed, in evaluation order. */
  readonly failedRules: readonly RiskRule[];
}

export interface RiskEngineInput {
  readonly order: RiskOrderInput;
  readonly portfolio: RiskPortfolioContext;
  readonly limits: RiskLimits;
  readonly flags: RiskFlags;
}

const isNil = (x: unknown): x is null | undefined => x === null || x === undefined;
const s = (x: Decimal | null): string | null => (x === null ? null : x.toString());
const PRICED: readonly TradeOrderType[] = ['LIMIT', 'STOP_LIMIT'];

/** Price used for notional: limit for priced orders, else the reference price. */
export function riskOrderPrice(order: RiskOrderInput): Decimal {
  return PRICED.includes(order.type) && order.limitPrice ? order.limitPrice : order.refPrice;
}

function validate(order: RiskOrderInput): void {
  if (!order.qty.isInteger() || !order.qty.gt(0))
    throw new RangeError('risk: qty must be a positive whole number');
  if (PRICED.includes(order.type) && !order.limitPrice)
    throw new RangeError(`risk: ${order.type} order requires limitPrice`);
  if ((order.type === 'STOP_LOSS' || order.type === 'STOP_LIMIT') && !order.stopPrice) {
    throw new RangeError(`risk: ${order.type} order requires stopPrice`);
  }
  if (order.limitPrice && !order.limitPrice.gt(0)) throw new RangeError('risk: limitPrice must be > 0');
  if (order.refPrice.isNeg()) throw new RangeError('risk: refPrice must be >= 0');
}

export function evaluateRisk(input: RiskEngineInput): RiskEvaluation {
  const { order, portfolio: p, limits: l, flags: f } = input;
  validate(order);
  const live = f.mode === 'LIVE';
  const buy = order.side === 'BUY';
  const price = riskOrderPrice(order);
  const value = order.qty.times(price);
  const results: RiskCheckResult[] = [];
  const add = (
    rule: RiskRule,
    passed: boolean,
    observed: string | null,
    limit: string | null,
    message: string,
  ): void => {
    results.push({ rule, passed, observed, limit, message });
  };
  const na = (rule: RiskRule, why: string): void => add(rule, true, null, null, `not applicable (${why})`);
  const noLimit = (rule: RiskRule, observed: string | null): void =>
    add(rule, true, observed, null, 'no limit configured');

  // 1 KILL_SWITCH
  if (!live) na('KILL_SWITCH', 'paper');
  else
    add(
      'KILL_SWITCH',
      f.killSwitchOn,
      String(f.killSwitchOn),
      'true',
      f.killSwitchOn ? 'live trading enabled' : 'live trading is disabled by the global kill switch',
    );

  // 2 CAPABILITY
  if (!live) na('CAPABILITY', 'paper');
  else
    add(
      'CAPABILITY',
      f.capabilityUsable,
      String(f.capabilityUsable),
      'true',
      f.capabilityUsable
        ? 'adapter capability usable'
        : 'adapter capability not implemented/verified/authorized/enabled',
    );

  // 3 MARKET_HOURS
  add(
    'MARKET_HOURS',
    f.marketOpen,
    f.marketOpen ? 'open' : 'closed',
    'open',
    f.marketOpen ? 'market open' : 'market is closed',
  );

  // 4 BUYING_POWER
  if (!buy) na('BUYING_POWER', 'sell');
  else {
    const available = p.cash.minus(p.pendingBuyValue);
    const ok = available.gte(order.estimatedTotal);
    add(
      'BUYING_POWER',
      ok,
      s(order.estimatedTotal),
      s(available),
      ok
        ? 'sufficient buying power'
        : `needs ${order.estimatedTotal.toString()} but only ${available.toString()} available (cash − pending buys)`,
    );
  }

  // 5 HOLDING_QTY
  if (buy) na('HOLDING_QTY', 'buy');
  else {
    const sellable = p.heldQty.minus(p.pendingSellQty);
    const ok = sellable.gte(order.qty);
    add(
      'HOLDING_QTY',
      ok,
      s(order.qty),
      s(sellable),
      ok
        ? 'sufficient holding'
        : `selling ${order.qty.toString()} but only ${sellable.toString()} sellable (held − pending sells)`,
    );
  }

  // 6 MAX_ORDER_VALUE
  if (isNil(l.maxOrderValue)) noLimit('MAX_ORDER_VALUE', s(value));
  else {
    const ok = value.lte(l.maxOrderValue);
    add(
      'MAX_ORDER_VALUE',
      ok,
      s(value),
      s(l.maxOrderValue),
      ok ? 'order value within limit' : 'order value exceeds maximum',
    );
  }

  // 7 MAX_ORDER_QTY
  if (isNil(l.maxOrderQty)) noLimit('MAX_ORDER_QTY', s(order.qty));
  else {
    const ok = order.qty.lte(l.maxOrderQty);
    add(
      'MAX_ORDER_QTY',
      ok,
      s(order.qty),
      s(l.maxOrderQty),
      ok ? 'quantity within limit' : 'quantity exceeds maximum',
    );
  }

  // 8 PRICE_BAND — |limit − last| / last × 100 ≤ priceBandPct (priced orders only)
  if (!PRICED.includes(order.type) || !order.limitPrice)
    na('PRICE_BAND', `${order.type.toLowerCase()} order has no limit price`);
  else if (isNil(l.priceBandPct)) noLimit('PRICE_BAND', null);
  else {
    const dev = pct(order.limitPrice.minus(order.refPrice).abs(), order.refPrice);
    if (dev === null)
      add('PRICE_BAND', false, null, s(l.priceBandPct), 'reference price is zero; cannot check price band');
    else {
      const ok = dev.lte(l.priceBandPct);
      add(
        'PRICE_BAND',
        ok,
        s(dev),
        s(l.priceBandPct),
        ok ? 'limit within price band' : `limit deviates ${dev.toString()}% from last price`,
      );
    }
  }

  // 9 DAILY_VALUE
  const dailyAfter = p.todayTradedValue.plus(value);
  if (isNil(l.maxDailyTradedValue)) noLimit('DAILY_VALUE', s(dailyAfter));
  else {
    const ok = dailyAfter.lte(l.maxDailyTradedValue);
    add(
      'DAILY_VALUE',
      ok,
      s(dailyAfter),
      s(l.maxDailyTradedValue),
      ok ? 'daily traded value within limit' : 'daily traded value limit would be exceeded',
    );
  }

  // 10 DAILY_COUNT
  const countAfter = p.todayOrderCount + 1;
  if (isNil(l.maxDailyOrders)) noLimit('DAILY_COUNT', String(countAfter));
  else {
    const ok = countAfter <= l.maxDailyOrders;
    add(
      'DAILY_COUNT',
      ok,
      String(countAfter),
      String(l.maxDailyOrders),
      ok ? 'daily order count within limit' : 'daily order count limit reached',
    );
  }

  // 11 CONCENTRATION — post-trade weight (BUY only; sells reduce concentration)
  if (!buy) na('CONCENTRATION', 'sell');
  else if (isNil(l.maxPositionPct)) noLimit('CONCENTRATION', null);
  else {
    const weight = pct(p.positionValue.plus(value), p.portfolioValue);
    if (weight === null)
      add(
        'CONCENTRATION',
        false,
        null,
        s(l.maxPositionPct),
        'portfolio value is zero; cannot check concentration',
      );
    else {
      const ok = weight.lte(l.maxPositionPct);
      add(
        'CONCENTRATION',
        ok,
        s(weight),
        s(l.maxPositionPct),
        ok ? 'post-trade weight within limit' : 'post-trade position weight exceeds limit',
      );
    }
  }

  // 12 DAILY_LOSS — block BUYs when down more than maxDailyLossPct today
  if (!buy) na('DAILY_LOSS', 'sell');
  else if (isNil(l.maxDailyLossPct)) noLimit('DAILY_LOSS', s(p.todayPnlPct));
  else {
    const ok = !p.todayPnlPct.lt(l.maxDailyLossPct.neg());
    add(
      'DAILY_LOSS',
      ok,
      s(p.todayPnlPct),
      s(l.maxDailyLossPct.neg()),
      ok ? 'daily loss within limit' : 'daily loss limit breached; buys blocked',
    );
  }

  // 13 MARKET_ORDERS_ALLOWED
  if (order.type !== 'MARKET') na('MARKET_ORDERS_ALLOWED', 'not a market order');
  else
    add(
      'MARKET_ORDERS_ALLOWED',
      l.allowMarketOrders,
      'MARKET',
      String(l.allowMarketOrders),
      l.allowMarketOrders ? 'market orders allowed' : 'market orders are disabled',
    );

  // 14 PRICE_SOURCE — LIVE refuses SIMULATED or stale prices
  if (!live) {
    add(
      'PRICE_SOURCE',
      true,
      f.priceIsSimulated ? 'SIMULATED' : f.priceIsStale ? 'STALE' : 'OK',
      null,
      'not applicable (paper)',
    );
  } else {
    const ok = !f.priceIsSimulated && !f.priceIsStale;
    const observed = f.priceIsSimulated ? 'SIMULATED' : f.priceIsStale ? 'STALE' : 'OK';
    add(
      'PRICE_SOURCE',
      ok,
      observed,
      'live, non-simulated',
      ok ? 'price source acceptable' : `live orders refuse ${observed.toLowerCase()} prices`,
    );
  }

  const failedRules = results.filter((r) => !r.passed).map((r) => r.rule);
  return { passed: failedRules.length === 0, results, failedRules };
}
