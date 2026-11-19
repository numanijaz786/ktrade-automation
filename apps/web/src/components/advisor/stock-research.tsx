'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { CandleChart } from '@/components/candle-chart';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge, PROVENANCE } from '@/components/provenance-badge';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RATIO_LABEL, HORIZON_LABEL } from '@/lib/api/advisor-rules';
import { useAdvisorStock, useCandles } from '@/lib/api/hooks';
import {
  ADVISOR_HORIZONS,
  type AdvisorEvaluation,
  type RatioOutcome,
  type StockReport,
  type StockTechnicals,
} from '@/lib/api/types-advisor';
import { Dec } from '@/lib/decimal';
import { formatDate, formatDateTime, formatNumber, formatPercent, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { ActionBadge, Disclaimer, KeyValue, PriceLine, Unavailable, WarningList } from './advisor-bits';

const num = (v: string | null, dp = 2): string => (v ? formatNumber(v, { dp }) : 'unavailable');
const cmpWord = (price: string | undefined, level: string | null): string => {
  if (!price || !level) return '';
  const p = Dec.of(price);
  return p.gt(level)
    ? 'The price is above it (a good sign).'
    : p.lt(level)
      ? 'The price is below it (a weak sign).'
      : 'The price is right at it.';
};

const TREND_WORDS: Record<string, string> = {
  STRONG_UPTREND: 'The price has been rising steadily: a strong uptrend.',
  UPTREND: 'The price is generally rising: an uptrend.',
  SIDEWAYS: 'The price is moving sideways without a clear direction.',
  DOWNTREND: 'The price is generally falling: a downtrend.',
  STRONG_DOWNTREND: 'The price has been falling steadily: a strong downtrend.',
  UNKNOWN: 'There is not enough history to judge the trend.',
};

export interface TechRow {
  name: string;
  value: string;
  plain: string;
}

/** Plain-English line for each indicator, from the API values only. */
export function techRows(t: StockTechnicals, price: string | undefined): TechRow[] {
  const rows: TechRow[] = [];
  rows.push({
    name: 'Trend',
    value: humanize(t.trend.classification),
    plain: TREND_WORDS[t.trend.classification] ?? TREND_WORDS.UNKNOWN!,
  });
  rows.push({
    name: 'RSI (14 days)',
    value: num(t.rsi14, 1),
    plain: !t.rsi14
      ? 'Unavailable: not enough price history.'
      : Dec.of(t.rsi14).gt(70)
        ? 'Above 70: the price has risen fast and may be overheated.'
        : Dec.of(t.rsi14).lt(30)
          ? 'Below 30: the price has fallen fast and may be oversold.'
          : 'Between 30 and 70: neither overheated nor oversold.',
  });
  rows.push({
    name: 'MACD histogram',
    value: num(t.macdHistogram, 4),
    plain: !t.macdHistogram
      ? 'Unavailable: not enough price history.'
      : Dec.of(t.macdHistogram).gt(0)
        ? 'Positive: short-term momentum is stronger than the longer trend.'
        : 'Zero or negative: short-term momentum is weaker than the longer trend.',
  });
  for (const [label, level] of [
    ['Average price, 20 days', t.trend.sma20],
    ['Average price, 50 days', t.trend.sma50],
    ['Average price, 100 days', t.trend.sma100],
    ['Average price, 200 days', t.trend.sma200],
  ] as const)
    rows.push({
      name: label,
      value: num(level),
      plain: level ? cmpWord(price, level) : 'Unavailable: not enough price history.',
    });
  rows.push({
    name: 'Support',
    value: num(t.support),
    plain: t.support ? 'A price area where falls have recently stopped.' : 'No clear support level found.',
  });
  rows.push({
    name: 'Resistance',
    value: num(t.resistance),
    plain: t.resistance
      ? 'A price area where rises have recently stopped.'
      : 'No clear resistance level found.',
  });
  rows.push({
    name: 'Volume vs recent average',
    value: t.volume.relativeVolume ? `${formatNumber(t.volume.relativeVolume, { dp: 2 })}x` : 'unavailable',
    plain: !t.volume.relativeVolume
      ? 'Unavailable.'
      : Dec.of(t.volume.relativeVolume).gte(2)
        ? 'Much busier than usual.'
        : Dec.of(t.volume.relativeVolume).lt(1)
          ? 'Quieter than usual.'
          : 'About as busy as usual.',
  });
  rows.push({
    name: 'Money flow',
    value: t.volume.adTrend ? humanize(t.volume.adTrend) : 'unavailable',
    plain:
      t.volume.adTrend === 'ACCUMULATION'
        ? 'Buyers seem to be gathering shares.'
        : t.volume.adTrend === 'DISTRIBUTION'
          ? 'Sellers seem to be unloading shares.'
          : 'No clear buying or selling pressure.',
  });
  rows.push({
    name: 'Average daily value traded',
    value: num(t.volume.avgTradedValue20, 0),
    plain: 'How much money changes hands on a typical day: higher is easier to buy and sell.',
  });
  rows.push({
    name: 'Breakout',
    value: t.breakout.crossed ? (t.breakout.confirmed ? 'Yes, confirmed' : 'Yes, not confirmed') : 'No',
    plain: t.breakout.crossed
      ? t.breakout.confirmed
        ? 'The price moved above its recent ceiling on strong volume.'
        : 'The price moved above its recent ceiling, but volume did not confirm it.'
      : 'The price has not broken above its recent ceiling.',
  });
  return rows;
}

function Technicals({ t, price }: { t: StockTechnicals; price: string | undefined }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t.basis}</p>
      {t.notice && <WarningList items={[t.notice]} title="Be careful" />}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Indicator</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>In plain English</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {techRows(t, price).map((r) => (
              <TableRow key={r.name}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="tabular">{r.value}</TableCell>
                <TableCell>{r.plain}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {t.trend.explanation.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {t.trend.explanation.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Candlestick patterns, when the rules find one, are listed in the reasons for each time frame below.
      </p>
    </div>
  );
}

function Ratios({ r }: { r: StockReport }) {
  if (!r.ratios)
    return (
      <p className="text-sm" data-testid="ratios-unavailable">
        <Unavailable what="Ratios" />:{' '}
        {r.ratiosReason ?? 'no financial statements are stored for this stock.'}{' '}
        <Link href="/financials" className="underline underline-offset-2">
          Add financial statements
        </Link>
      </p>
    );
  const show = (o: RatioOutcome) =>
    o.status === 'OK' ? (
      <span className="tabular">
        {formatNumber(o.value, { dp: 2 })}
        {o.flags.length > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">{o.flags.map(humanize).join(', ')}</span>
        )}
      </span>
    ) : (
      <span className="text-muted-foreground">
        unavailable{o.missing.length ? ` — missing: ${o.missing.join(', ')}` : ` — ${o.reason}`}
      </span>
    );
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ratio</TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(r.ratios).map(([k, o]) => (
            <TableRow key={k}>
              <TableCell className="font-medium">{RATIO_LABEL[k] ?? humanize(k)}</TableCell>
              <TableCell>{show(o)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Valuation({ v }: { v: StockReport['valuation'] }) {
  if (v.status !== 'OK')
    return (
      <p className="text-sm" data-testid="valuation-unavailable">
        <Unavailable what="Valuation" />: {v.reason ?? 'the inputs it needs are missing.'}
        {v.explanation.length > 0 && (
          <span className="block text-xs text-muted-foreground">{v.explanation.join(' ')}</span>
        )}
      </p>
    );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Reported facts</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Figures taken from the company’s own statements.
          </p>
          {v.facts.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="space-y-1 text-sm" data-testid="valuation-facts">
              {v.facts.map((f) => (
                <li key={`${f.name}-${f.period}`}>
                  {humanize(f.name)}: <span className="tabular">{formatNumber(f.value, { dp: 2 })}</span>{' '}
                  {f.currency}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({f.period}, {f.source})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Assumptions</h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These are choices made for the model, not facts. Change them and the answer changes.
          </p>
          {v.assumptions.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="space-y-1 text-sm" data-testid="valuation-assumptions">
              {v.assumptions.map((a) => (
                <li key={`${a.name}-${a.value}`}>
                  {humanize(a.name)}: <span className="tabular">{a.value}</span>{' '}
                  <span className="text-xs text-muted-foreground">({a.basis})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KeyValue label="Estimated fair value (model output)">
          {v.fairValueLow && v.fairValueHigh ? (
            `${formatNumber(v.fairValueLow)} – ${formatNumber(v.fairValueHigh)}`
          ) : (
            <Unavailable />
          )}
        </KeyValue>
        <KeyValue label="Margin of safety vs the lowest estimate">
          {v.marginOfSafetyPct ? formatPercent(v.marginOfSafetyPct) : <Unavailable />}
        </KeyValue>
      </dl>
      {v.explanation.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {v.explanation.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HorizonCard({ ev }: { ev: AdvisorEvaluation }) {
  return (
    <Card data-testid="horizon-card" data-horizon={ev.horizon}>
      <CardContent className="space-y-2 pt-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{HORIZON_LABEL[ev.horizon]}</h3>
          <ActionBadge action={ev.action} />
        </div>
        <p>{ev.headline}</p>
        {ev.status === 'NOT_ACTIONABLE' && ev.notActionableReasons.length > 0 && (
          <ul className="list-disc pl-5 text-muted-foreground">
            {ev.notActionableReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {ev.plan && (
          <dl className="grid grid-cols-2 gap-2">
            <KeyValue label="Buy between">
              {formatNumber(ev.plan.entry.low)} – {formatNumber(ev.plan.entry.high)}
            </KeyValue>
            <KeyValue label="Stop-loss">{formatNumber(ev.plan.stopLoss.price)}</KeyValue>
            {ev.plan.targets.map((t) => (
              <KeyValue key={t.n} label={`Target ${t.n}`}>
                {formatNumber(t.price)}
              </KeyValue>
            ))}
            <KeyValue label="Confidence">
              {ev.confidence ? `${formatNumber(ev.confidence.score, { dp: 0 })} / 100` : <Unavailable />}
            </KeyValue>
          </dl>
        )}
        {ev.reasons.length > 0 && (
          <ul className="list-disc pl-5">
            {ev.reasons.slice(0, 6).map((r) => (
              <li key={`${r.ruleId}-${r.text}`}>{r.text}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Chart({ symbol }: { symbol: string }) {
  const [from] = useState(() => new Date(Date.now() - 183 * 86_400_000).toISOString().slice(0, 10));
  const candles = useCandles(symbol, from);
  return (
    <QueryState query={candles} rows={6}>
      {(c) => <CandleChart symbol={symbol} candles={c.candles} />}
    </QueryState>
  );
}

export function StockResearchBody({ r }: { r: StockReport }) {
  const ds = r.dataSources;
  return (
    <div className="space-y-8" data-testid="stock-research">
      <PageHeader
        title={`${r.symbol} · ${r.name}`}
        description={r.sector ?? 'Sector unavailable'}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/market/${encodeURIComponent(r.symbol)}`}>Stock details</Link>
          </Button>
        }
      />
      <div>
        <p className="text-xs text-muted-foreground">Latest price</p>
        <PriceLine price={r.price} />
      </div>

      <Section title="What the advisor says, by time frame">
        {Object.keys(r.recommendations).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No time-frame view could be produced: there are no stored prices for this stock.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {ADVISOR_HORIZONS.flatMap((h) => {
              const ev = r.recommendations[h];
              return ev ? [<HorizonCard key={h} ev={ev} />] : [];
            })}
          </div>
        )}
      </Section>

      <Section title="Daily price chart">
        <Chart symbol={r.symbol} />
      </Section>

      <Section title="Technical picture" description="What the price chart is saying.">
        {r.technicals ? (
          <Technicals t={r.technicals} price={r.price?.value} />
        ) : (
          <p className="text-sm">
            <Unavailable what="Technicals" />: there are no stored daily prices.
          </p>
        )}
      </Section>

      <Section title="Company numbers (ratios)">
        <Ratios r={r} />
      </Section>

      <Section
        title="Valuation"
        description="What the stock might be worth, kept apart from the facts it is built on."
      >
        <Valuation v={r.valuation} />
      </Section>

      <Section title="Recent announcements">
        {r.announcements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent announcements are stored for this stock.</p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="announcements">
            {r.announcements.map((a) => (
              <li key={a.id} className="rounded-md border p-2">
                <p className="font-medium">
                  {a.url ? (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      {a.title}
                    </a>
                  ) : (
                    a.title
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {formatDate(a.publishedAt)}
                  {a.category ? ` · ${humanize(a.category)}` : ''}
                  {a.source && <ProvenanceBadge source={a.source} compact />}
                  {a.sourceName ? `· ${a.sourceName}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Where this data comes from">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="data-sources">
          <KeyValue label="Daily prices">
            {ds.bars.count} bars
            <span className="block text-xs font-normal text-muted-foreground">
              latest {ds.bars.latestBarTs ? formatDateTime(ds.bars.latestBarTs) : 'unavailable'}
              {ds.bars.latestBarSource
                ? ` · ${(PROVENANCE as Record<string, { label: string }>)[ds.bars.latestBarSource]?.label ?? ds.bars.latestBarSource}`
                : ''}
            </span>
          </KeyValue>
          <KeyValue label="Price sources">
            {ds.bars.sources.length ? ds.bars.sources.map(humanize).join(', ') : 'none'}
          </KeyValue>
          <KeyValue label="Company financials">
            {ds.fundamentals ? (
              <>
                {ds.fundamentals.period}
                <span className="block text-xs font-normal text-muted-foreground">
                  published {formatDate(ds.fundamentals.publishedAt)} · {humanize(ds.fundamentals.source)} ·{' '}
                  {ds.fundamentals.peersUsed} peers
                </span>
              </>
            ) : (
              <Unavailable />
            )}
          </KeyValue>
          <KeyValue label="Freshness">
            {ds.stale ? 'Stale: the price is out of date' : 'Within the freshness limit'}
          </KeyValue>
        </dl>
      </Section>

      <Disclaimer />
    </div>
  );
}

export function StockResearchView({ symbol }: { symbol: string }) {
  const { portfolioId } = useActivePortfolio();
  const report = useAdvisorStock(symbol, portfolioId);
  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/advisor">
          <ArrowLeft aria-hidden="true" /> Advisor
        </Link>
      </Button>
      <QueryState query={report} rows={8}>
        {(r) => <StockResearchBody r={r} />}
      </QueryState>
    </div>
  );
}
