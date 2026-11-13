import type {
  BarDto,
  MarketDataCapabilities,
  MarketDataProvider,
  ProviderHealth,
  QuoteDto,
  Unsubscribe,
} from '@ktrade/broker-sdk';
import { type Decimal, d, fromInt, max, min, ONE, round, ZERO } from '@ktrade/finance-core';
import type { DataSource, PriceInterval } from '@ktrade/shared';
import type { Clock } from '../../common/clock.js';
import { addDays, pktDateOf, type PsxCalendar } from '../calendar.js';
import { formatChangePct, formatPrice, INTERVAL_MINUTES, MIN_TICK, SYMBOL_RE, toTick } from '../decimal-format.js';
import { SeededRng } from '../rng.js';

/** First simulated trading day. Bars before it do not exist (keeps the deterministic walk bounded). */
export const SIM_EPOCH = '2022-01-03';
/** Bump to deliberately change every generated series (part of every seed string). */
const SIM_VERSION = 'v1';

const MEAN_REVERSION = d('0.004'); // per day, toward the anchor price — keeps multi-year paths plausible
const GAP_SCALE = d('0.25');
const WICK_SCALE = d('0.5');
const HALF = d('0.5');
const VOLUME_MOVE_SCALE = d('8');
const INTRADAY_NOISE_SCALE = d('0.6');

interface Profile {
  base: Decimal;
  /** Daily volatility as a fraction (0.012 – 0.030). */
  sigma: Decimal;
  baseVolume: Decimal;
}

interface DayBar {
  date: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: bigint;
}

interface Series {
  profile: Profile;
  /** Every weekday from SIM_EPOCH (holidays included in the walk; they are only filtered from output). */
  days: Map<string, DayBar>;
  lastDate: string | null;
  /** Unrounded price state of the walk. */
  state: Decimal;
}

interface IntradayPath {
  /** N+1 tick-rounded price points; point i is the price at session open + i minutes. */
  points: Decimal[];
  /** N per-minute volumes summing exactly to the day's volume. */
  volumes: bigint[];
}

export interface SimulatedProviderOptions {
  /** Live tick cadence for subscribe(). Default 5 s. */
  tickMs?: number;
  /** Max cached intraday days (LRU-ish). Default 256. */
  intradayCacheSize?: number;
}

/**
 * Deterministic synthetic PSX market (docs/09 §B1). Every value it produces is labelled SIMULATED.
 *
 * Daily bars: a mean-reverting geometric random walk seeded by (symbol, date), so any bar can be
 * regenerated identically after a restart. Prices sit on the PSX 0.01 tick, are always positive and
 * satisfy high ≥ max(open, close) ≥ min(open, close) ≥ low.
 * Intraday: a Brownian bridge from the day's open to its close, clamped into [low, high] and touching
 * both, so M1/M5/M15/H1 bars aggregate exactly to the D1 bar (volume included).
 * Quotes follow the intraday path minute by minute during the session (via the injected clock).
 * All arithmetic is decimal (finance-core); the PRNG only yields integers.
 */
export class SimulatedMarketDataProvider implements MarketDataProvider {
  readonly key = 'simulated';
  readonly displayName = 'Simulated market (synthetic data)';
  readonly source: DataSource = 'SIMULATED';

  private readonly series = new Map<string, Series>();
  private readonly intraday = new Map<string, IntradayPath>();
  private readonly tickMs: number;
  private readonly intradayCacheSize: number;

  constructor(
    private readonly clock: Clock,
    private readonly calendar: () => PsxCalendar,
    private readonly basePrices: ReadonlyMap<string, string> = new Map(),
    options: SimulatedProviderOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 5_000;
    this.intradayCacheSize = options.intradayCacheSize ?? 256;
  }

  capabilities(): MarketDataCapabilities {
    return { quotes: true, intradayBars: true, eodBars: true, corporateActions: false, streaming: true, delayMinutes: 0 };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true, checkedAt: this.clock.now().toISOString(), message: 'Synthetic data — every value is SIMULATED' };
  }

  async getQuotes(symbols: readonly string[]): Promise<QuoteDto[]> {
    const now = this.clock.now();
    return symbols.map((s) => this.quoteAt(s, now));
  }

  async getBars(symbol: string, interval: PriceInterval, from: Date, to: Date): Promise<BarDto[]> {
    assertSymbol(symbol);
    const cal = this.calendar();
    const now = this.clock.now();
    const end = Math.min(to.getTime(), now.getTime());
    const fromDate = maxDate(pktDateOf(from), SIM_EPOCH);
    const toDate = pktDateOf(new Date(end));
    const out: BarDto[] = [];
    if (fromDate > toDate) return out;

    for (const date of cal.tradingDays(fromDate, toDate)) {
      if (interval === 'D1') {
        const ts = cal.sessionOpen(date);
        if (ts < from || ts.getTime() > end || cal.sessionClose(date) > now) continue;
        const bar = this.day(symbol, date);
        out.push(this.toBarDto(symbol, 'D1', ts, bar.open, bar.high, bar.low, bar.close, bar.volume));
        continue;
      }
      const k = INTERVAL_MINUTES[interval];
      const open = cal.sessionOpen(date).getTime();
      const path = this.path(symbol, date);
      const n = path.volumes.length;
      for (let i = 0; i < n; i += k) {
        const j = Math.min(i + k, n);
        const ts = new Date(open + i * 60_000);
        // Only completed bars; a bar in progress would leak the rest of its minute.
        if (ts < from || ts.getTime() > end || open + j * 60_000 > now.getTime()) continue;
        let hi = path.points[i]!;
        let lo = hi;
        let vol = 0n;
        for (let m = i; m <= j; m++) {
          hi = max(hi, path.points[m]!);
          lo = min(lo, path.points[m]!);
          if (m < j) vol += path.volumes[m]!;
        }
        out.push(this.toBarDto(symbol, interval, ts, path.points[i]!, hi, lo, path.points[j]!, vol));
      }
    }
    return out;
  }

  /** Emits a fresh quote per symbol every `tickMs` while the market is open, only when it changed. */
  subscribe(symbols: readonly string[], onQuote: (q: QuoteDto) => void): Unsubscribe {
    symbols.forEach(assertSymbol);
    const lastSeen = new Map<string, string>();
    const timer = setInterval(() => {
      const now = this.clock.now();
      if (!this.calendar().isOpen(now)) return;
      for (const s of symbols) {
        const q = this.quoteAt(s, now);
        const sig = `${q.asOf}|${q.last}`;
        if (lastSeen.get(s) === sig) continue;
        lastSeen.set(s, sig);
        onQuote(q);
      }
    }, this.tickMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Quote as of `now`: follows the intraday path during the session, else the last completed session. */
  quoteAt(symbol: string, now: Date): QuoteDto {
    assertSymbol(symbol);
    const cal = this.calendar();
    const today = pktDateOf(now);
    const inOrAfterSession = cal.isTradingDay(today) && now >= cal.sessionOpen(today);
    const date = inOrAfterSession ? today : cal.previousTradingDay(today);
    if (date < SIM_EPOCH) throw new RangeError(`No simulated data before ${SIM_EPOCH}`);
    const prevDate = cal.previousTradingDay(date);
    const prevClose = prevDate < SIM_EPOCH ? toTick(this.profile(symbol).base) : this.day(symbol, prevDate).close;
    const bar = this.day(symbol, date);

    let last = bar.close;
    let high = bar.high;
    let low = bar.low;
    let volume = bar.volume;
    let asOf = cal.sessionClose(date);
    if (inOrAfterSession && now < cal.sessionClose(today)) {
      const path = this.path(symbol, date);
      const m = Math.floor((now.getTime() - cal.sessionOpen(date).getTime()) / 60_000);
      last = path.points[m]!;
      high = last;
      low = last;
      volume = 0n;
      for (let i = 0; i <= m; i++) {
        high = max(high, path.points[i]!);
        low = min(low, path.points[i]!);
        if (i < m) volume += path.volumes[i]!;
      }
      asOf = new Date(cal.sessionOpen(date).getTime() + m * 60_000);
    }
    const change = last.minus(prevClose);
    return {
      symbol,
      last: formatPrice(last),
      open: formatPrice(bar.open),
      prevClose: formatPrice(prevClose),
      high: formatPrice(high),
      low: formatPrice(low),
      volume: volume.toString(),
      change: formatPrice(change),
      changePct: formatChangePct(change, prevClose),
      asOf: asOf.toISOString(),
      delayMinutes: 0,
      source: this.source,
      providerKey: this.key,
    };
  }

  // ───────────────────────── generation ─────────────────────────

  private profile(symbol: string): Profile {
    return this.getSeries(symbol).profile;
  }

  private getSeries(symbol: string): Series {
    let s = this.series.get(symbol);
    if (!s) {
      const rng = new SeededRng(`sim:${SIM_VERSION}:profile:${symbol}`);
      const configured = this.basePrices.get(symbol);
      const base = configured ? d(configured) : fromInt(20 + rng.intBelow(480));
      const sigma = d('0.012').plus(fromInt(rng.intBelow(181)).div(d('10000')));
      const baseVolume = fromInt(200_000 + rng.intBelow(4_800_000));
      s = { profile: { base, sigma, baseVolume }, days: new Map(), lastDate: null, state: base };
      this.series.set(symbol, s);
    }
    return s;
  }

  /** Daily bar for a weekday on/after SIM_EPOCH. Extends the walk lazily and caches it. */
  private day(symbol: string, date: string): DayBar {
    if (date < SIM_EPOCH) throw new RangeError(`No simulated data before ${SIM_EPOCH}`);
    const s = this.getSeries(symbol);
    const cached = s.days.get(date);
    if (cached) return cached;
    const { base, sigma, baseVolume } = s.profile;
    let cursor = s.lastDate === null ? SIM_EPOCH : addDays(s.lastDate, 1);
    let prevClose = s.lastDate === null ? toTick(base) : s.days.get(s.lastDate)!.close;
    while (cursor <= date) {
      const wd = new Date(`${cursor}T00:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6) {
        const rng = new SeededRng(`sim:${SIM_VERSION}:${symbol}:${cursor}`);
        const zClose = rng.normal();
        const zGap = rng.normal();
        const zHigh = rng.normal().abs();
        const zLow = rng.normal().abs();
        const u = rng.uniform();

        const open = toTick(prevClose.times(ONE.plus(sigma.times(GAP_SCALE).times(zGap))));
        const drift = MEAN_REVERSION.times(base.minus(s.state)).div(s.state);
        s.state = s.state.times(ONE.plus(sigma.times(zClose)).plus(drift));
        const close = toTick(s.state);
        const high = round(max(open, close).times(ONE.plus(zHigh.times(sigma).times(WICK_SCALE))), 2, 'UP');
        const low = max(MIN_TICK, round(min(open, close).times(ONE.minus(zLow.times(sigma).times(WICK_SCALE))), 2, 'DOWN'));
        const move = close.div(prevClose).minus(ONE).abs();
        const volume = BigInt(
          baseVolume.times(HALF.plus(u)).times(ONE.plus(VOLUME_MOVE_SCALE.times(move))).floor().toFixed(0),
        );
        s.days.set(cursor, { date: cursor, open, high, low, close, volume });
        s.lastDate = cursor;
        prevClose = close;
      }
      cursor = addDays(cursor, 1);
    }
    const bar = s.days.get(date);
    if (!bar) throw new RangeError(`${date} is not a weekday`);
    return bar;
  }

  private path(symbol: string, date: string): IntradayPath {
    const n = this.calendar().sessionMinutes;
    const cacheKey = `${symbol}|${date}|${n}`;
    const hit = this.intraday.get(cacheKey);
    if (hit) return hit;

    const bar = this.day(symbol, date);
    const { sigma } = this.profile(symbol);
    const rng = new SeededRng(`sim:${SIM_VERSION}:intraday:${symbol}:${date}`);
    const nD = fromInt(n);
    const step = sigma.times(INTRADAY_NOISE_SCALE).div(nD.sqrt());

    // Brownian bridge B (B_0 = B_n = 0) around the straight line open → close.
    const walk: Decimal[] = [ZERO];
    for (let i = 1; i <= n; i++) walk.push(walk[i - 1]!.plus(rng.normal().times(step)));
    const endW = walk[n]!;
    const points: Decimal[] = [];
    for (let i = 0; i <= n; i++) {
      const frac = fromInt(i).div(nD);
      const bridge = walk[i]!.minus(frac.times(endW));
      const line = bar.open.plus(bar.close.minus(bar.open).times(frac));
      points.push(max(bar.low, min(bar.high, toTick(line.times(ONE.plus(bridge))))));
    }
    points[0] = bar.open;
    points[n] = bar.close;
    // Make the session actually trade at the day's high and low.
    if (n >= 3) {
      const iHigh = 1 + rng.intBelow(n - 1);
      let iLow = 1 + rng.intBelow(n - 1);
      if (iLow === iHigh) iLow = iHigh === 1 ? 2 : iHigh - 1;
      points[iHigh] = bar.high;
      points[iLow] = bar.low;
    }

    // U-shaped integer volume weights (busier open and close), split exactly with bigint maths.
    const weights: bigint[] = [];
    let total = 0n;
    for (let i = 0; i < n; i++) {
      const w = BigInt(500 + rng.intBelow(1000) + (i < 30 || i >= n - 30 ? 1000 : 0));
      weights.push(w);
      total += w;
    }
    const volumes: bigint[] = [];
    let allocated = 0n;
    for (let i = 0; i < n; i++) {
      const v = i === n - 1 ? bar.volume - allocated : (bar.volume * weights[i]!) / total;
      volumes.push(v);
      allocated += v;
    }

    const path = { points, volumes };
    if (this.intraday.size >= this.intradayCacheSize) {
      const oldest = this.intraday.keys().next().value;
      if (oldest !== undefined) this.intraday.delete(oldest);
    }
    this.intraday.set(cacheKey, path);
    return path;
  }

  private toBarDto(
    symbol: string,
    interval: PriceInterval,
    ts: Date,
    open: Decimal,
    high: Decimal,
    low: Decimal,
    close: Decimal,
    volume: bigint,
  ): BarDto {
    return {
      symbol,
      interval,
      ts: ts.toISOString(),
      open: formatPrice(open),
      high: formatPrice(high),
      low: formatPrice(low),
      close: formatPrice(close),
      volume: volume.toString(),
      isAdjusted: false,
    };
  }
}

function assertSymbol(symbol: string): void {
  if (!SYMBOL_RE.test(symbol)) throw new RangeError(`Invalid symbol: ${symbol}`);
}

const maxDate = (a: string, b: string): string => (a > b ? a : b);
