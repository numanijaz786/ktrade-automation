'use client';

import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage, type FieldError } from '@/lib/api/errors';

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_SHOWN = 50;

export interface CsvRowError {
  /** 1-based line in the file, or null for a whole-file problem. */
  line: number | null;
  field: string | null;
  message: string;
}

/** The API reports CSV problems as `rows.<line>[.<field>]`. */
export function parseRowError(e: FieldError): CsvRowError {
  const m = /^rows\.(\d+)(?:\.(.+))?$/.exec(e.path);
  if (!m) return { line: null, field: e.path || null, message: e.message };
  return { line: Number(m[1]), field: m[2] ?? null, message: e.message };
}

/** Row-level errors from a rejected import, or the plain error message. Nothing is saved when this shows. */
export function CsvErrorList({ error }: { error: unknown }) {
  const rows = error instanceof ApiError ? error.errors.map(parseRowError) : [];
  if (rows.length === 0)
    return (
      <Alert variant="destructive" data-testid="csv-error">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Import failed</AlertTitle>
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </Alert>
    );
  return (
    <Alert variant="destructive" data-testid="csv-error">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        Nothing was imported: {rows.length} {rows.length === 1 ? 'problem' : 'problems'} found
      </AlertTitle>
      <AlertDescription>
        <p>The file is checked as a whole. Fix these rows and import it again.</p>
        <ul className="mt-2 max-h-56 list-disc space-y-0.5 overflow-auto pl-5" aria-label="Row errors">
          {rows.slice(0, MAX_SHOWN).map((r, i) => (
            <li key={i}>
              {r.line !== null ? <strong>Line {r.line}</strong> : <strong>File</strong>}
              {r.field ? ` · ${r.field}` : ''}: {r.message}
            </li>
          ))}
        </ul>
        {rows.length > MAX_SHOWN && <p className="mt-1">…and {rows.length - MAX_SHOWN} more.</p>}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Paste or upload CSV text and import it. The server validates the whole file; any bad row means nothing is
 * saved and every row error is listed here.
 */
export function CsvImport<R>({
  title,
  columns,
  example,
  mutation,
  summarize,
}: {
  title: string;
  /** Plain description of the columns. */
  columns: ReactNode;
  example: string;
  mutation: { mutateAsync: (csv: string) => Promise<R>; isPending: boolean };
  summarize: (result: R) => ReactNode;
}) {
  const id = useId();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<R | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_CSV_BYTES) {
      setFileError('That file is larger than 2 MB. Split it into smaller files.');
      return;
    }
    setFileError(null);
    setCsv(await f.text());
    setResult(null);
    setError(null);
  }

  async function submit() {
    setResult(null);
    setError(null);
    try {
      setResult(await mutation.mutateAsync(csv));
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="space-y-3" aria-label={title}>
      <p className="text-sm text-muted-foreground">{columns}</p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-file`}>CSV file</Label>
        <Input id={`${id}-file`} type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} />
        {fileError && (
          <p className="text-xs text-destructive" role="alert">
            {fileError}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-text`}>Or paste the CSV text</Label>
        <Textarea
          id={`${id}-text`}
          value={csv}
          rows={6}
          placeholder={example}
          className="font-mono text-xs"
          onChange={(e) => setCsv(e.target.value)}
        />
      </div>
      <Button type="button" disabled={mutation.isPending || csv.trim() === ''} onClick={() => void submit()}>
        <Upload aria-hidden="true" /> {mutation.isPending ? 'Importing…' : 'Import CSV'}
      </Button>
      {error !== null && <CsvErrorList error={error} />}
      {result !== null && (
        <Alert data-testid="csv-result">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>Import finished</AlertTitle>
          <AlertDescription>{summarize(result)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
