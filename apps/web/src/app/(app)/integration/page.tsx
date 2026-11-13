'use client';

import { CheckCircle2, FileUp, Info, ShieldOff, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState, QueryState } from '@/components/states';
import { GenericStatus } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api/errors';
import { useConnections, useImportMutations, useImportRows, useImports } from '@/lib/api/hooks';
import type { ImportBatch, ImportRow } from '@/lib/api/types';
import { useActivePortfolio } from '@/lib/portfolio-context';

const MAX_BYTES = 2 * 1024 * 1024;
type Tone = 'neutral' | 'info' | 'warn' | 'good' | 'bad';

const ROW_TONE: Record<ImportRow['status'], Tone> = {
  PENDING: 'neutral',
  VALID: 'good',
  INVALID: 'bad',
  DUPLICATE: 'warn',
  MATCHED: 'info',
  COMMITTED: 'good',
  SKIPPED: 'neutral',
};
const BATCH_TONE: Record<ImportBatch['status'], Tone> = {
  UPLOADED: 'neutral',
  PARSING: 'info',
  AWAITING_REVIEW: 'warn',
  COMMITTING: 'info',
  COMMITTED: 'good',
  REJECTED: 'neutral',
  FAILED: 'bad',
};

const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong';

export default function IntegrationPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="KTrade integration"
        description="Broker connections and statement imports. KTrade publishes no API and has not authorised automation, so data arrives through files you import."
      />
      <ConnectionsSection />
      <ImportsSection />
    </div>
  );
}

function ConnectionsSection() {
  const query = useConnections();
  return (
    <Section
      title="Connections"
      description="Every automated capability must be implemented, verified, authorised in writing by KTrade, and enabled by you. Until then it stays off."
    >
      <QueryState query={query} rows={3}>
        {(connections) => (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Adapter</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Usable capabilities</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((c) => {
                  const usable = Object.entries(c.capabilities).filter(
                    ([, s]) => s.implemented && s.verified && s.authorized && s.enabled,
                  );
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="font-medium">{c.label}</div>
                        <div className="text-muted-foreground text-xs">{c.description}</div>
                      </TableCell>
                      <TableCell>
                        <GenericStatus
                          value={c.status.replace(/_/g, ' ').toLowerCase()}
                          tone={c.status === 'CONNECTED' ? 'good' : 'neutral'}
                        />
                      </TableCell>
                      <TableCell className="text-sm">
                        {usable.length ? (
                          usable.map(([k]) => k).join(', ')
                        ) : (
                          <span className="text-muted-foreground inline-flex items-center gap-1">
                            <ShieldOff className="size-4" aria-hidden /> none — awaiting written authorisation
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
    </Section>
  );
}

function ImportsSection() {
  const { portfolios, portfolioId } = useActivePortfolio();
  const livePortfolios = portfolios.filter((p) => p.kind === 'LIVE');
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const target = targetId ?? livePortfolios.find((p) => p.id === portfolioId)?.id ?? livePortfolios[0]?.id;
  const [selected, setSelected] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imports = useImports();
  const m = useImportMutations();

  async function onFile(file: File | undefined) {
    if (!file || !target) return;
    if (file.size > MAX_BYTES) {
      toast.error('File too large', { description: 'The limit is 2 MB.' });
      return;
    }
    try {
      const batch = await m.upload.mutateAsync({
        portfolioId: target,
        fileName: file.name,
        content: await file.text(),
      });
      setSelected(batch.id);
      toast.success('File staged for review', {
        description: `${file.name}: nothing is posted until you commit.`,
      });
    } catch (e) {
      toast.error('Upload rejected', { description: errorText(e) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <Section
      title="Statement imports"
      description="Upload a CSV of your trades (date, symbol, side, quantity, price; optional commission, sst, cdc, contract_no). Rows are reviewed before anything reaches your ledger."
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload</CardTitle>
          <CardDescription>
            Charges missing from the file are estimated from KTrade&apos;s published fee schedule and labelled{' '}
            <strong>Estimated</strong> until a broker statement confirms them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          {livePortfolios.length === 0 ? (
            <Alert>
              <Info className="size-4" />
              <AlertTitle>No live portfolio yet</AlertTitle>
              <AlertDescription>
                Register your KTrade account first. Imports go into a LIVE portfolio, never into paper
                trading.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="import-target">Import into</Label>
                <Select value={target} onValueChange={setTargetId}>
                  <SelectTrigger id="import-target" className="w-64">
                    <SelectValue placeholder="Choose portfolio" />
                  </SelectTrigger>
                  <SelectContent>
                    {livePortfolios.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose a CSV file to import"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <Button onClick={() => fileInput.current?.click()} disabled={!target || m.upload.isPending}>
                <FileUp className="size-4" aria-hidden />
                {m.upload.isPending ? 'Uploading…' : 'Choose CSV file'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <QueryState query={imports} rows={3}>
        {(batches) =>
          batches.length === 0 ? (
            <EmptyState title="No imports yet" description="Uploaded files appear here for review." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Rows</TableHead>
                    <TableHead>Data source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="sr-only">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id} data-state={selected === b.id ? 'selected' : undefined}>
                      <TableCell className="font-medium">{b.fileName}</TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {b.periodFrom ? `${b.periodFrom} → ${b.periodTo}` : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {Object.entries(b.rowCounts)
                          .map(([k, v]) => `${v} ${k.toLowerCase()}`)
                          .join(', ') || '—'}
                      </TableCell>
                      <TableCell>{b.source ? <ProvenanceBadge source={b.source} compact /> : '—'}</TableCell>
                      <TableCell>
                        <GenericStatus
                          value={b.status.replace(/_/g, ' ').toLowerCase()}
                          tone={BATCH_TONE[b.status]}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => setSelected(b.id)}>
                          {b.status === 'AWAITING_REVIEW' ? 'Review' : 'View'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryState>

      {selected && imports.data && (
        <ImportReview batch={imports.data.find((b) => b.id === selected)} onClose={() => setSelected(null)} />
      )}
    </Section>
  );
}

function ImportReview({ batch, onClose }: { batch: ImportBatch | undefined; onClose: () => void }) {
  const rows = useImportRows(batch?.id ?? null);
  const m = useImportMutations();
  const reviewing = batch?.status === 'AWAITING_REVIEW';
  const invalid = useMemo(() => (rows.data ?? []).filter((r) => r.status === 'INVALID').length, [rows.data]);
  const toCommit = useMemo(() => (rows.data ?? []).filter((r) => r.status === 'VALID').length, [rows.data]);
  if (!batch) return null;

  const act = async (rowId: string, action: 'skip' | 'include') => {
    try {
      await m.updateRow.mutateAsync({ importId: batch.id, rowId, action });
    } catch (e) {
      toast.error('Could not update row', { description: errorText(e) });
    }
  };
  const commit = async () => {
    try {
      await m.commit.mutateAsync(batch.id);
      toast.success('Import committed', {
        description: `${toCommit} trade(s) posted to your ledger in one transaction.`,
      });
    } catch (e) {
      toast.error('Commit failed — nothing was posted', { description: errorText(e) });
    }
  };
  const reject = async () => {
    try {
      await m.reject.mutateAsync(batch.id);
      toast.message('Import rejected', { description: 'No data was posted.' });
    } catch (e) {
      toast.error('Could not reject', { description: errorText(e) });
    }
  };

  return (
    <Card aria-labelledby="review-title">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle id="review-title" className="text-base">
            {batch.fileName}
          </CardTitle>
          <CardDescription>
            {reviewing
              ? 'Duplicates are skipped unless you include them. Invalid rows must be skipped (or fixed in the file) before committing — nothing is dropped silently.'
              : `This import is ${batch.status.toLowerCase().replace(/_/g, ' ')}.`}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {reviewing && (
            <>
              <Button
                onClick={() => void commit()}
                disabled={invalid > 0 || toCommit === 0 || m.commit.isPending}
              >
                <CheckCircle2 className="size-4" aria-hidden />
                {m.commit.isPending ? 'Committing…' : `Commit ${toCommit} row${toCommit === 1 ? '' : 's'}`}
              </Button>
              <Button variant="outline" onClick={() => void reject()} disabled={m.reject.isPending}>
                <XCircle className="size-4" aria-hidden /> Reject
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {reviewing && invalid > 0 && (
          <Alert variant="destructive">
            <AlertTitle>
              {invalid} invalid row{invalid === 1 ? '' : 's'}
            </AlertTitle>
            <AlertDescription>
              Skip them or fix the file and upload it again. The commit is blocked until then.
            </AlertDescription>
          </Alert>
        )}
        <QueryState query={rows} rows={5}>
          {(data) => (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Charges</TableHead>
                    <TableHead>Notes</TableHead>
                    {reviewing && <TableHead className="sr-only">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="tabular-nums">{r.rowNo}</TableCell>
                      <TableCell>
                        <GenericStatus value={r.status.toLowerCase()} tone={ROW_TONE[r.status]} />
                      </TableCell>
                      <TableCell className="tabular-nums">{r.tradeDate ?? '—'}</TableCell>
                      <TableCell className="font-medium">{r.symbol ?? '—'}</TableCell>
                      <TableCell>{r.side ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.quantity ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.price ?? '—'}</TableCell>
                      <TableCell>
                        {r.feeSource === 'FILE' ? (
                          <span className="text-sm tabular-nums">
                            {r.fees
                              .map((f) => `${f.component.toLowerCase().replace(/_/g, ' ')} ${f.amount}`)
                              .join(', ')}
                          </span>
                        ) : r.feeSource === 'ESTIMATED_ON_COMMIT' ? (
                          <ProvenanceBadge
                            source="ESTIMATED"
                            compact
                            note="Estimated from the fee schedule on commit"
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="max-w-80 text-sm">
                        {r.errors.map((e) => (
                          <div key={e} className="text-destructive">
                            {e}
                          </div>
                        ))}
                        {r.warnings
                          .filter((w) => !/ESTIMATED/.test(w))
                          .map((w) => (
                            <div key={w} className="text-muted-foreground">
                              {w}
                            </div>
                          ))}
                      </TableCell>
                      {reviewing && (
                        <TableCell className="text-right">
                          {r.status === 'DUPLICATE' || (r.status === 'SKIPPED' && r.errors.length === 0) ? (
                            <Button size="sm" variant="outline" onClick={() => void act(r.id, 'include')}>
                              Include
                            </Button>
                          ) : r.status !== 'SKIPPED' ? (
                            <Button size="sm" variant="ghost" onClick={() => void act(r.id, 'skip')}>
                              Skip
                            </Button>
                          ) : null}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
