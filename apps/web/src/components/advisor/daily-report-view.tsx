'use client';

import Link from 'next/link';
import { Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState } from '@/components/states';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AdvisorEvaluation, DailyReport } from '@/lib/api/types-advisor';
import { formatDateTime, formatNumber, formatPKR, humanize } from '@/lib/format';
import {
  ActionBadge,
  DataQualityBanner,
  Disclaimer,
  NotEnoughDataPanel,
  PriceLine,
  Unavailable,
  WarningList,
} from './advisor-bits';
import { BuyCard } from './buy-card';

/** Headline first, so the answer to "what should I do today" is the first thing on the page. */
export function Headline({ report }: { report: DailyReport }) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-4">
        <p className="text-xs text-muted-foreground">
          {report.portfolio.name} · {report.horizon.replace('_', '-').toLowerCase()} view · data as of{' '}
          {report.dataAsOf ?? 'unavailable'}
        </p>
        <h2 className="text-xl font-semibold" data-testid="advisor-headline">
          {report.headline}
        </h2>
      </CardContent>
    </Card>
  );
}

function AvoidCard({ ev }: { ev: AdvisorEvaluation }) {
  return (
    <Card data-testid="avoid-card" data-symbol={ev.symbol}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">
            <Link href={`/research/${encodeURIComponent(ev.symbol)}`} className="hover:underline">
              {ev.symbol}
            </Link>
            {ev.name && <span className="ml-2 text-sm font-normal text-muted-foreground">{ev.name}</span>}
          </h3>
          <ActionBadge action={ev.action} />
        </div>
        <PriceLine price={ev.price} />
        <p className="text-sm">{ev.headline}</p>
        {ev.reasons.length > 0 && (
          <ul className="list-disc pl-5 text-sm">
            {ev.reasons.slice(0, 5).map((r) => (
              <li key={`${r.ruleId}-${r.text}`}>{r.text}</li>
            ))}
          </ul>
        )}
        <WarningList items={ev.warnings} />
      </CardContent>
    </Card>
  );
}

export function WhatChanged({ report }: { report: DailyReport }) {
  const w = report.whatChanged;
  return (
    <Section title="What changed since the last run">
      {w.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {w.baseline
            ? `Nothing changed across the ${w.compared} stocks compared.`
            : (w.note ?? 'There is no earlier run to compare with yet.')}
        </p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {w.events.map((e, i) => (
            <li key={`${e.symbol}-${e.kind}-${i}`}>
              <span className="font-medium">{e.symbol}</span>: {e.detail}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function OpportunityTable({ rows }: { rows: AdvisorEvaluation[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Stock</TableHead>
            <TableHead>Advice</TableHead>
            <TableHead>Latest price</TableHead>
            <TableHead>Buy between</TableHead>
            <TableHead>Confidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.symbol}>
              <TableCell>{r.rank ?? ''}</TableCell>
              <TableCell>
                <Link
                  href={`/research/${encodeURIComponent(r.symbol)}`}
                  className="font-medium hover:underline"
                >
                  {r.symbol}
                </Link>
              </TableCell>
              <TableCell>
                <ActionBadge action={r.action} />
              </TableCell>
              <TableCell>
                <PriceLine price={r.price} />
              </TableCell>
              <TableCell className="tabular">
                {r.plan ? (
                  `${formatNumber(r.plan.entry.low)} – ${formatNumber(r.plan.entry.high)}`
                ) : (
                  <Unavailable />
                )}
              </TableCell>
              <TableCell className="tabular">
                {r.confidence ? `${formatNumber(r.confidence.score, { dp: 0 })} / 100` : <Unavailable />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function BuyList({ report }: { report: DailyReport }) {
  if (report.notEnoughData)
    return (
      <p className="text-sm text-muted-foreground" data-testid="buys-withheld">
        No buy ideas are shown because there is not enough verified data. No entry range, stop-loss, target or
        confidence is given for any stock.
      </p>
    );
  if (report.topBuys.length === 0)
    return (
      <EmptyState
        title="Nothing to buy today"
        description="No stock passed all the checks on verified data. Doing nothing is a valid result."
      />
    );
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {report.topBuys.slice(0, 5).map((ev) => (
        <BuyCard key={ev.symbol} ev={ev} />
      ))}
    </div>
  );
}

export function DailyReportView({ report }: { report: DailyReport }) {
  const withheld = report.notEnoughData !== null;
  return (
    <div className="space-y-8" data-testid="daily-report">
      <Headline report={report} />
      <DataQualityBanner q={report.dataQuality} />
      {report.notEnoughData && <NotEnoughDataPanel n={report.notEnoughData} />}

      <WhatChanged report={report} />

      <Section
        title="Top buys"
        description="At most five ideas, best first. Each shows where it got its data."
        actions={
          !withheld &&
          report.topBuys.length > 0 && (
            <Link href="/advisor/buy" className="text-sm underline underline-offset-2">
              Open buy opportunities
            </Link>
          )
        }
      >
        <BuyList report={report} />
      </Section>

      <Section title="Avoid or sell" description="At most five stocks the rules say to stay away from.">
        {withheld ? (
          <p className="text-sm text-muted-foreground">Not shown: not enough verified data.</p>
        ) : report.avoidOrSell.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stock is flagged to avoid or sell today.</p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {report.avoidOrSell.slice(0, 5).map((ev) => (
              <AvoidCard key={ev.symbol} ev={ev} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Hold" description="Stocks you own where the advice is to keep holding.">
        {report.holds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holding is marked “continue holding”.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {report.holds.map((h) => (
              <li key={h.symbol}>
                <span className="font-medium">{h.symbol}</span>: {h.headline}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm">
          <Link href="/advisor/portfolio" className="underline underline-offset-2">
            See each holding in My Portfolio Manager
          </Link>
        </p>
      </Section>

      <Section title="Best opportunities" description="Ranked list, up to 20.">
        {withheld ? (
          <p className="text-sm text-muted-foreground">Not shown: not enough verified data.</p>
        ) : report.opportunities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No opportunities passed the checks today.</p>
        ) : (
          <OpportunityTable rows={report.opportunities} />
        )}
      </Section>

      <Section
        title="News affecting you"
        description={`Announcements about stocks you hold or watch, last ${report.newsImpact.windowHours} hours.`}
      >
        {report.newsImpact.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {report.newsImpact.note ?? 'No relevant announcements.'}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {report.newsImpact.items.map((n) => (
              <li key={n.id} className="rounded-md border p-2">
                <p className="font-medium">
                  {n.url ? (
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      {n.title}
                    </a>
                  ) : (
                    n.title
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {n.affects
                    .map(
                      (a) => `${a.symbol} (${a.relation === 'HELD' ? 'you hold it' : 'on your watchlist'})`,
                    )
                    .join(', ')}
                  · {formatDateTime(n.publishedAt)}
                  {n.category ? ` · ${humanize(n.category)}` : ''}
                  {n.source && <ProvenanceBadge source={n.source} compact />}
                  {n.sourceName ? `· ${n.sourceName}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Coverage: {report.newsImpact.coverage || 'unknown'}
          {report.newsImpact.lastUpdated
            ? ` · last updated ${formatDateTime(report.newsImpact.lastUpdated)}`
            : ''}
        </p>
      </Section>

      <Section title="Portfolio notes" description="Concentration, cash and drawdown.">
        <p className="text-sm text-muted-foreground">
          Cash {formatPKR(report.portfolio.cash)} · total value {formatPKR(report.portfolio.equity)}
        </p>
        {report.portfolioNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {report.portfolioNotes.map((n, i) => (
              <li key={`${n.kind}-${i}`} className={n.severity === 'WARN' ? 'font-medium' : undefined}>
                {n.severity === 'WARN' ? 'Warning: ' : ''}
                {n.text}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Disclaimer text={report.disclaimer} />
    </div>
  );
}
