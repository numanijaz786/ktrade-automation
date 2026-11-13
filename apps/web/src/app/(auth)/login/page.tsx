'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import type { z } from 'zod';
import { loginSchema } from '@ktrade/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/errors';
import { useLogin } from '@/lib/api/hooks';
import { safeNextPath } from '@/lib/safe-next';

type LoginIn = z.input<typeof loginSchema>;
type LoginOut = z.output<typeof loginSchema>;

function loginErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
    if (e.code === 'INVALID_TOTP') return 'That two-factor code is not valid. Use a fresh code.';
    if (e.code === 'ACCOUNT_LOCKED') return 'Too many failed attempts. The account is locked for 15 minutes.';
    if (e.status === 429) return 'Too many attempts. Wait a minute and try again.';
    return e.message;
  }
  return 'Could not sign in. Check your connection and try again.';
}

export default function LoginPage() {
  const router = useRouter();
  const login = useLogin();
  const [totpRequired, setTotpRequired] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<LoginIn, unknown, LoginOut>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: LoginOut) {
    setFormError(null);
    try {
      const res = await login.mutateAsync(values);
      if (res.totpRequired) {
        setTotpRequired(true);
        setFormError(values.totpCode ? null : 'Enter the 6-digit code from your authenticator app.');
        return;
      }
      router.replace(safeNextPath(new URLSearchParams(window.location.search).get('next')));
    } catch (e) {
      setFormError(loginErrorText(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Your personal PSX trading workspace.</CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <CardContent className="space-y-4">
          {formError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
              {...form.register('email')}
            />
            {errors.email && (
              <p id="email-error" className="text-sm text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
              {...form.register('password')}
            />
            {errors.password && (
              <p id="password-error" className="text-sm text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>
          {totpRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="totpCode">Two-factor code</Label>
              <Input
                id="totpCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                aria-invalid={!!errors.totpCode}
                aria-describedby={errors.totpCode ? 'totp-error' : undefined}
                {...form.register('totpCode', { setValueAs: (v: string) => (v ? v.trim() : undefined) })}
              />
              {errors.totpCode && (
                <p id="totp-error" className="text-sm text-destructive">
                  {errors.totpCode.message}
                </p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="mt-6 flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
            Sign in
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            First time here?{' '}
            <Link href="/register" className="underline underline-offset-2">
              Create the owner account
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
