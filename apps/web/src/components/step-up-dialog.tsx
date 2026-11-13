'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStepUp } from '@/lib/api/hooks';
import { errorMessage } from '@/lib/api/errors';

export interface StepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** Receives the short-lived step-up token; throw to show an error and keep the dialog open. */
  onVerified: (token: string) => Promise<unknown> | unknown;
  children?: ReactNode;
}

/** 🔐 Step-up: confirm a sensitive action with a TOTP code (docs/07 §1). */
export function StepUpDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', onVerified, children }: StepUpDialogProps) {
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();

  const close = (o: boolean) => {
    if (!o) {
      setCode('');
      setError(null);
    }
    onOpenChange(o);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await stepUp.mutateAsync(code);
      await onVerified(token);
      close(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" aria-hidden="true" /> {title}
            </DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-totp`}>Authenticator code</Label>
            <Input
              id={`${id}-totp`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-invalid={!!error}
              aria-describedby={`${id}-help ${error ? `${id}-err` : ''}`}
              className="font-mono tracking-[0.3em]"
              autoFocus
            />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              Demo: any 6 digits except 000000. The token lasts 5 minutes.
            </p>
            {error && (
              <p id={`${id}-err`} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
