'use client';

import { useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import { CsvImport } from '@/components/csv-import';
import { PageHeader, Section } from '@/components/page-header';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNow } from '@/hooks/use-now';
import { useMe, useNewsFeed, useResearchMutations } from '@/lib/api/hooks';
import type { AnnouncementsImportResult } from '@/lib/api/types';
import { AnnouncementFormDialog } from './announcement-form';
import { MacroPanel } from './macro-panel';
import { NewsFeedView } from './news-feed';

const CSV_EXAMPLE = `publishedAt,title,category,symbols,url,summary
2026-11-12,Board meeting to consider results,BOARD_MEETING,OGDC,https://example.com/notice,Results on 20 Nov`;

export function summarizeAnnouncementsImport(r: AnnouncementsImportResult) {
  return (
    <>
      {r.rows} {r.rows === 1 ? 'row' : 'rows'} read: <strong>{r.inserted} added</strong>,{' '}
      <strong>{r.skipped} skipped</strong> because {r.skipped === 1 ? 'it was' : 'they were'} already on file
      (or repeated in the file). Saved as entered by you.
    </>
  );
}

export default function IntelligencePage() {
  const me = useMe();
  const isOwner = me.data?.role === 'OWNER';
  const now = useNow(60_000);
  const [windowHours, setWindowHours] = useState(72);
  const [category, setCategory] = useState('all');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const feed = useNewsFeed({ windowHours });
  const { importAnnouncements } = useResearchMutations();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Market intelligence"
        description="Announcements and news you have entered, and the macro figures behind them. Nothing here is fetched automatically."
        actions={
          isOwner && (
            <>
              <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                <FileUp aria-hidden="true" /> Import CSV
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" /> Add announcement
              </Button>
            </>
          )
        }
      />

      <QueryState query={feed} rows={5}>
        {(f) => (
          <NewsFeedView
            feed={f}
            now={now}
            windowHours={windowHours}
            onWindowChange={setWindowHours}
            category={category}
            onCategoryChange={setCategory}
            isOwner={isOwner}
          />
        )}
      </QueryState>

      <Section
        title="Macro observations"
        description="Policy rate, inflation, exchange rate, KIBOR and the KSE-100 level."
      >
        <MacroPanel isOwner={isOwner} />
      </Section>

      <AnnouncementFormDialog open={adding} onOpenChange={setAdding} />
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import announcements from CSV</DialogTitle>
            <DialogDescription>
              The whole file is checked first. If any row is wrong, nothing is saved and you see every
              problem.
            </DialogDescription>
          </DialogHeader>
          {importing && (
            <CsvImport
              title="Announcements CSV"
              columns={
                <>
                  Required columns: <code>publishedAt</code>, <code>title</code>. Optional:{' '}
                  <code>category</code>, <code>symbol</code>, <code>symbols</code> (separate with ;),{' '}
                  <code>url</code>, <code>summary</code>, <code>sourceName</code>, <code>sentiment</code>,{' '}
                  <code>relevance</code>. Rows already on file are skipped.
                </>
              }
              example={CSV_EXAMPLE}
              mutation={importAnnouncements}
              summarize={summarizeAnnouncementsImport}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
