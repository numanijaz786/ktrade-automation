'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/field';
import { NativeSelect } from '@/components/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { useResearchMutations } from '@/lib/api/hooks';
import {
  EMPTY_ANNOUNCEMENT,
  validateAnnouncementForm,
  type AnnouncementFormValues,
  type FormErrors,
} from '@/lib/api/research-rules';
import { humanize } from '@/lib/format';
import { CATEGORIES } from './news-feed';

/** Owner form: record one announcement. Saved as entered by you (USER_REPORTED); 409 means it is already on file. */
export function AnnouncementForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { addAnnouncement } = useResearchMutations();
  const [v, setV] = useState<AnnouncementFormValues>(EMPTY_ANNOUNCEMENT);
  const [errors, setErrors] = useState<FormErrors<AnnouncementFormValues>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = (k: keyof AnnouncementFormValues, val: string) => setV((p) => ({ ...p, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const r = validateAnnouncementForm(v, Date.now());
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    addAnnouncement.mutate(r.input, {
      onSuccess: () => {
        toast.success('Announcement added');
        onDone();
      },
      onError: (err) =>
        setServerError(
          err instanceof ApiError && err.status === 409
            ? 'Already recorded: an announcement with the same title, link and publication time is on file. Nothing was added.'
            : errorMessage(err),
        ),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="New announcement">
      <FormField id="an-title" label="Headline" error={errors.title}>
        <Input
          id="an-title"
          value={v.title}
          aria-invalid={!!errors.title}
          onChange={(e) => set('title', e.target.value)}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="an-category" label="Category" error={errors.category}>
          <NativeSelect id="an-category" value={v.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField
          id="an-symbols"
          label="Stock symbols"
          error={errors.symbols}
          hint="Optional. Separate with commas."
        >
          <Input
            id="an-symbols"
            value={v.symbols}
            placeholder="OGDC, PPL"
            autoCapitalize="characters"
            aria-invalid={!!errors.symbols}
            onChange={(e) => set('symbols', e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField id="an-date" label="Published on" error={errors.date}>
          <Input
            id="an-date"
            type="date"
            value={v.date}
            aria-invalid={!!errors.date}
            onChange={(e) => set('date', e.target.value)}
          />
        </FormField>
        <FormField id="an-time" label="Time (Pakistan time)" error={errors.time} hint="Optional, like 14:30.">
          <Input
            id="an-time"
            type="time"
            value={v.time}
            aria-invalid={!!errors.time}
            onChange={(e) => set('time', e.target.value)}
          />
        </FormField>
      </div>
      <FormField
        id="an-url"
        label="Link to the original"
        error={errors.url}
        hint="Optional. Starts with https://"
      >
        <Input
          id="an-url"
          value={v.url}
          aria-invalid={!!errors.url}
          onChange={(e) => set('url', e.target.value)}
        />
      </FormField>
      <FormField
        id="an-summary"
        label="Short summary"
        error={errors.summary}
        hint="Optional. Your own words."
      >
        <Textarea
          id="an-summary"
          rows={3}
          value={v.summary}
          aria-invalid={!!errors.summary}
          onChange={(e) => set('summary', e.target.value)}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="an-source" label="Source name" hint="Optional. Default: Owner-entered.">
          <Input id="an-source" value={v.sourceName} onChange={(e) => set('sourceName', e.target.value)} />
        </FormField>
        <FormField
          id="an-sentiment"
          label="Sentiment"
          error={errors.sentiment}
          hint="Optional. Only set it if you judged it yourself."
        >
          <NativeSelect
            id="an-sentiment"
            value={v.sentiment}
            onChange={(e) => set('sentiment', e.target.value)}
          >
            <option value="">Not assessed</option>
            <option value="POSITIVE">Positive</option>
            <option value="NEUTRAL">Neutral</option>
            <option value="NEGATIVE">Negative</option>
          </NativeSelect>
        </FormField>
      </div>
      {serverError && (
        <Alert variant="destructive" data-testid="announcement-server-error">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={addAnnouncement.isPending}>
          Add announcement
        </Button>
      </div>
    </form>
  );
}

export function AnnouncementFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add an announcement</DialogTitle>
          <DialogDescription>
            Copy it from the PSX or company notice. It is saved as entered by you, and the same item cannot be
            added twice.
          </DialogDescription>
        </DialogHeader>
        {open && <AnnouncementForm onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
