'use client';

import type { DataSource } from '@ktrade/shared';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPKR, formatPercent, toneClass, toneOf, type MoneyFormatOptions } from '@/lib/format';
import { ProvenanceBadge } from './provenance-badge';

interface SourceProps {
  source?: DataSource;
  asOf?: string;
  note?: string;
  compactBadge?: boolean;
}

/** A PKR amount with its provenance badge. */
export function Money({ value, source, asOf, note, compactBadge = true, className, ...fmt }: { value: string | null | undefined; className?: string } & SourceProps & MoneyFormatOptions) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 tabular', className)}>
      <span>{formatPKR(value, fmt)}</span>
      {source && <ProvenanceBadge source={source} asOf={asOf} note={note} compact={compactBadge} />}
    </span>
  );
}

const ICON = { gain: ArrowUpRight, loss: ArrowDownRight, flat: Minus } as const;
const WORD = { gain: 'up', loss: 'down', flat: 'unchanged' } as const;

/**
 * Signed P&L in PKR (or percent). Direction is conveyed by sign, arrow and colour together,
 * never colour alone.
 */
export function PnlText({
  value,
  percent = false,
  showIcon = true,
  source,
  asOf,
  note,
  compactBadge = true,
  className,
  ...fmt
}: { value: string | null | undefined; percent?: boolean; showIcon?: boolean; className?: string } & SourceProps & MoneyFormatOptions) {
  const tone = toneOf(value);
  const Icon = ICON[tone];
  const text = percent ? formatPercent(value, { signed: true, dp: fmt.dp }) : formatPKR(value, { signed: true, ...fmt });
  return (
    <span className={cn('inline-flex items-center gap-1 tabular', toneClass(tone), className)}>
      {showIcon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      <span>
        <span className="sr-only">{WORD[tone]} </span>
        {text}
      </span>
      {source && <ProvenanceBadge source={source} asOf={asOf} note={note} compact={compactBadge} />}
    </span>
  );
}
