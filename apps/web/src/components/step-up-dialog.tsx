'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiClient } from '@/lib/api/client';
import { useMe, useStepUp } from '@/lib/api/hooks';
import { errorMessage } from '@/lib/api/errors';
import type { StepUpProof } from '@/lib/api/types';

export interface StepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /**
   * Receives the short-lived step-up token; throw to show an error and keep the dialog open.
   * The token is only passed along in memory — never stored.
   */
  onVerified: (token: string) => Promise<unknown> | unknown;
  children?: ReactNode;
}

/**
 * 🔐 Step-up (docs/07 §1): confirm a sensitive action with a fresh second factor. Users with TOTP enabled
 * enter their authenticator code; users without TOTP re-enter their password (the API accepts either).
 */
export function StepUpDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  onVerified,
  children,
}: StepUpDialogProps) {
  const id = useId();
  const api = useApiClient();
  const me = useMe();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();
  // Only an explicit `totpEnabled: false` switches to password mode; unknown stays on TOTP.
  const mode: 'totp' | 'password' = me.data?.totpEnabled === false ? 'password' : 'totp';

  const close = (o: boolean) => {
    if (!o) {
      setValue('');
      setError(null);
    }
    onOpenChange(o);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    let proof: StepUpProof;
    if (mode === 'totp') {
      if (!/^\d{6}$/.test(value)) {
        setError('Enter the 6-digit code from your authenticator app.');
        return;
      }
      proof = { totpCode: value };
    } else {
      if (!value) {
        setError('Enter your account password.');
        return;
      }
      proof = { password: value };
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await stepUp.mutateAsync(proof);
      setValue('');
      await onVerified(token);
      close(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const inputId = `${id}-${mode}`;
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
            {mode === 'totp' ? (
              <>
                <Label htmlFor={inputId}>Authenticator code</Label>
                <Input
                  id={inputId}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="123456"
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-invalid={!!error}
                  aria-describedby={`${id}-help ${error ? `${id}-err` : ''}`}
                  className="font-mono tracking-[0.3em]"
                  autoFocus
                />
              </>
            ) : (
              <>
                <Label htmlFor={inputId}>Account password</Label>
                <Input
                  id={inputId}
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={`${id}-help ${error ? `${id}-err` : ''}`}
                  autoFocus
                />
              </>
            )}
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {mode === 'totp'
                ? 'Two-factor authentication is on, so a fresh code is required.'
                : 'Two-factor authentication is off, so re-enter your password. Turning on TOTP is recommended.'}{' '}
              {api.kind === 'demo' &&
                (mode === 'totp' ? 'Demo: any 6 digits except 000000. ' : 'Demo: any 8+ characters. ')}
              The confirmation lasts 5 minutes and is kept in memory only.
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
