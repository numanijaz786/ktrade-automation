'use client';

import { useState, type FormEvent } from 'react';
import { FileUp, Info, Plus } from 'lucide-react';
import { CsvImport } from '@/components/csv-import';
import { FormField } from '@/components/field';
import { PageHeader, Section } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useFinancials, useMe, useResearchMutations } from '@/lib/api/hooks';
import type { FinancialPeriod, FinancialsImportResult } from '@/lib/api/types';
import { FinancialFormDialog } from './financial-form';
import { FinancialsTable } from './financials-table';

const CSV_EXAMPLE = `symbol,periodType,periodEnd,publishedAt,sourceRef,revenue,netProfit,eps
OGDC,ANNUAL,2025-06-30,2025-09-05,Annual report 2025 p.41,100000000000,40000000000,9.3`;

export function summarizeFinancialsImport(r: FinancialsImportResult) {
  return (
    <>
      {r.rows} {r.rows === 1 ? 'row' : 'rows'} read: <strong>{r.inserted} added</strong>,{' '}
      <strong>{r.updated} corrected</strong>, <strong>{r.unchanged} unchanged</strong>
      {r.symbols.length > 0 && <> ({r.symbols.join(', ')})</>}. Saved as entered by you.
    </>
  );
}

export default function FinancialsPage() {
  const me = useMe();
  const isOwner = me.data?.role === 'OWNER';
  const [draft, setDraft] = useState('');
  const [symbol, setSymbol] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FinancialPeriod | null>(null);
  const [importing, setImporting] = useState(false);
  const financials = useFinancials(symbol);
  const { importFinancials } = useResearchMutations();

  function load(e: FormEvent) {
    e.preventDefault();
    const s = draft.trim().toUpperCase();
    setSymbol(s || undefined);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial statements"
        description="Company results by period, exactly as entered. No ratios are worked out on this page."
        actions={
          isOwner && (
            <>
              <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                <FileUp aria-hidden="true" /> Import CSV
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" /> Add period
              </Button>
            </>
          )
        }
      />

      <Alert data-testid="user-reported-note">
        <Info aria-hidden="true" />
        <AlertTitle>Figures are entered by you (USER_REPORTED)</AlertTitle>
        <AlertDescription>
          Nobody has checked these numbers. They stay owner-entered until a licensed data source is connected
          (see Data providers). Nothing is estimated or filled in for you.
        </AlertDescription>
      </Alert>

      <form onSubmit={load} className="flex flex-wrap items-end gap-2" aria-label="Pick a stock">
        <div className="w-48">
          <FormField id="fin-symbol" label="Stock symbol">
            <Input
              id="fin-symbol"
              value={draft}
              placeholder="OGDC"
              autoCapitalize="characters"
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
            />
          </FormField>
        </div>
        <Button type="submit" variant="outline">
          Show periods
        </Button>
      </form>

      {!symbol ? (
        <EmptyState title="Pick a stock" description="Enter a symbol to see the periods on file for it." />
      ) : (
        <Section title={`${symbol} periods`} description="Newest first.">
          <QueryState query={financials} rows={4}>
            {(list) =>
              list.data.length === 0 ? (
                <EmptyState
                  title="No financials on file"
                  description={
                    list.note ??
                    'Nothing is estimated. Enter figures from the company report, or import a CSV file.'
                  }
                />
              ) : (
                <>
                  {list.note && <p className="text-sm text-muted-foreground">{list.note}</p>}
                  <FinancialsTable rows={list.data} isOwner={isOwner} onEdit={setEditing} />
                </>
              )
            }
          </QueryState>
        </Section>
      )}

      <FinancialFormDialog open={creating} onOpenChange={setCreating} defaultSymbol={symbol} />
      <FinancialFormDialog
        key={editing?.id ?? 'none'}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        period={editing ?? undefined}
      />
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import financials from CSV</DialogTitle>
            <DialogDescription>
              All or nothing: if any row is wrong, nothing is saved and every problem is listed.
            </DialogDescription>
          </DialogHeader>
          {importing && (
            <CsvImport
              title="Financials CSV"
              columns={
                <>
                  Required columns: <code>symbol</code>, <code>periodType</code> (QUARTERLY or ANNUAL),{' '}
                  <code>periodEnd</code>, <code>publishedAt</code>, <code>sourceRef</code>. Optional:{' '}
                  <code>currency</code>, <code>sourceUrl</code>, and any figure such as <code>revenue</code>,{' '}
                  <code>netProfit</code>, <code>eps</code>. A period already on file is corrected.
                </>
              }
              example={CSV_EXAMPLE}
              mutation={importFinancials}
              summarize={summarizeFinancialsImport}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
