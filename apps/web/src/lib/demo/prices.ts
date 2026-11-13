/**
 * Deterministic SIMULATED OHLCV: seeded geometric Brownian motion over the PSX trading calendar
 * (Mon–Fri; holidays ignored in the demo). Prices are generated as integer paisa so every
 * string emitted is exact to two decimals.
 */
import { DEMO_UNIVERSE, type DemoStockSeed } from './universe';

/** Last simulated trading day (the demo "today"). */
export const DEMO_TODAY = '2026-11-13';
/** Number of daily bars generated per symbol (~2 years). */
export const DEMO_BARS = 520;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Standard normal via Box–Muller. */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Business days ending at `end` (inclusive), oldest first. */
export function businessDays(end: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

export interface RawBar {
  date: string;
  /** paisa */
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** paisa integer → "123.45" without floating-point formatting. */
export function paisaToString(p: number): string {
  const neg = p < 0;
  const abs = Math.abs(Math.trunc(p));
  const rupees = Math.floor(abs / 100);
  const paisa = abs % 100;
  return `${neg ? '-' : ''}${rupees}.${paisa.toString().padStart(2, '0')}`;
}

export function toPaisa(rupees: number): number {
  return Math.max(1, Math.round(rupees * 100));
}

export function generateBars(seed: DemoStockSeed, days: readonly string[]): RawBar[] {
  const rand = mulberry32(hashSeed(seed.symbol));
  // Per-symbol drift between roughly −10% and +45% a year.
  const drift = (rand() * 0.55 - 0.1) / 250;
  let price = 1;
  const path: { date: string; open: number; close: number; hi: number; lo: number; volume: number }[] = [];
  for (const date of days) {
    const shock = gaussian(rand) * seed.vol;
    const open = price * (1 + gaussian(rand) * seed.vol * 0.25);
    const close = price * Math.exp(drift - (seed.vol * seed.vol) / 2 + shock);
    const hi = Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * seed.vol * 0.4);
    const lo = Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * seed.vol * 0.4);
    const volume = Math.round(seed.adv * Math.exp(gaussian(rand) * 0.45) * (1 + Math.abs(shock) * 12));
    path.push({ date, open, close, hi, lo, volume });
    price = close;
  }
  // Scale the path so the latest close lands near the seed's reference price.
  const k = seed.basePrice / price;
  return path.map((b) => {
    const o = toPaisa(b.open * k);
    const c = toPaisa(b.close * k);
    return { date: b.date, open: o, close: c, high: Math.max(toPaisa(b.hi * k), o, c), low: Math.min(toPaisa(b.lo * k), o, c), volume: b.volume };
  });
}

let cache: Map<string, RawBar[]> | null = null;

/** All symbols' bars, generated once per process. */
export function allBars(): Map<string, RawBar[]> {
  if (!cache) {
    const days = businessDays(DEMO_TODAY, DEMO_BARS);
    cache = new Map(DEMO_UNIVERSE.map((s) => [s.symbol, generateBars(s, days)]));
  }
  return cache;
}

export function barsFor(symbol: string): RawBar[] {
  return allBars().get(symbol) ?? [];
}

/** Close (paisa) on or before `date`. */
export function closeOn(symbol: string, date: string): number {
  const bars = barsFor(symbol);
  let lo = 0;
  let hi = bars.length - 1;
  let ans = bars[0]?.close ?? 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      ans = bars[mid].close;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
