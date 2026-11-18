import { describe, expect, it } from 'vitest';
import { readCsv, splitCsv } from './csv.js';
import { announcementDedupeHash, normalizeTitle, normalizeUrl } from './dedupe.js';

const at = new Date('2026-11-10T04:00:00Z');

describe('announcement dedupe', () => {
  it('normalises case, punctuation and whitespace in titles', () => {
    expect(normalizeTitle('  Board  Meeting: Q1 results! ')).toBe('board meeting q1 results');
  });

  it('normalises host case, fragments and trailing slashes in urls', () => {
    expect(normalizeUrl('HTTPS://Example.com/a/b/#top')).toBe('https://example.com/a/b');
    expect(normalizeUrl(undefined)).toBe('');
  });

  it('same item written differently hashes the same; different time or title differs', () => {
    const a = announcementDedupeHash({
      title: 'Board Meeting: Q1',
      url: 'https://X.com/a/',
      publishedAt: at,
    });
    const b = announcementDedupeHash({ title: 'board meeting q1', url: 'https://x.com/a', publishedAt: at });
    expect(a).toBe(b);
    const later = new Date(at.getTime() + 1);
    expect(
      announcementDedupeHash({ title: 'board meeting q1', url: 'https://x.com/a', publishedAt: later }),
    ).not.toBe(a);
    expect(
      announcementDedupeHash({ title: 'board meeting q2', url: 'https://x.com/a', publishedAt: at }),
    ).not.toBe(a);
  });
});

describe('splitCsv', () => {
  it('handles quoted commas, doubled quotes and embedded newlines, tracking start lines', () => {
    const rows = splitCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",z\n');
    expect(rows).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'say "hi"'] },
      { line: 3, fields: ['multi\nline', 'z'] },
    ]);
  });
});

describe('readCsv', () => {
  const spec = { required: ['symbol'], optional: ['title'], maxRows: 2 };
  it('rejects unknown/missing columns, ragged rows and too many rows with line numbers', () => {
    expect(readCsv('foo\n1', spec).issues.map((i) => i.message)).toEqual([
      'unknown column "foo"',
      'missing column "symbol"',
    ]);
    expect(readCsv('symbol,title\nA\n', spec).issues[0]).toMatchObject({ line: 2 });
    expect(readCsv('symbol\nA\nB\nC\n', spec).issues[0]).toMatchObject({ line: 4 });
  });
  it('omits blank cells and is case-insensitive on headers', () => {
    const r = readCsv('SYMBOL,Title\nA,\n', spec);
    expect(r.issues).toEqual([]);
    expect(r.records[0]!.values).toEqual({ symbol: 'A' });
  });
});
