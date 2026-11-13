'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import type { z } from 'zod';
import { registerSchema } from '@ktrade/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/errors';
import { useRegister } from '@/lib/api/hooks';

type RegisterIn = z.input<typeof registerSchema>;
type RegisterOut = z.output<typeof registerSchema>;

const FIELDS = [
  { name: 'displayName', label: 'Your name', type: 'text', autoComplete: 'name' },
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
  { name: 'password', label: 'Password (12+ characters)', type: 'password', autoComplete: 'new-password' },
] as const;

export default function RegisterPage() {
  const router = useRouter();
  const register = useRegister();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<RegisterIn, unknown, RegisterOut>({
    resolver: zodResolver(registerSchema),
    defaultValues: { displayName: '', email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: RegisterOut) {
    setFormError(null);
    try {
      await register.mutateAsync(values);
      router.replace('/market/overview');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REGISTRATION_CLOSED')
        setFormError('An owner account already exists. Sign in instead.');
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED')
        setFormError(e.errors.map((x) => `${x.path}: ${x.message}`).join('; ') || e.message);
      else setFormError(e instanceof ApiError ? e.message : 'Could not create the account.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create the owner account</CardTitle>
        <CardDescription>
          Registration is open only until the single owner account exists. Never use your KTrade password
          here.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <CardContent className="space-y-4">
          {formError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          {FIELDS.map((f) => {
            const err = errors[f.name];
            return (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={f.name}>{f.label}</Label>
                <Input
                  id={f.name}
                  type={f.type}
                  autoComplete={f.autoComplete}
                  aria-invalid={!!err}
                  aria-describedby={err ? `${f.name}-error` : undefined}
                  {...form.register(f.name)}
                />
                {err && (
                  <p id={`${f.name}-error`} className="text-sm text-destructive">
                    {err.message}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
        <CardFooter className="mt-6 flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
            Create account
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Already registered?{' '}
            <Link href="/login" className="underline underline-offset-2">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
