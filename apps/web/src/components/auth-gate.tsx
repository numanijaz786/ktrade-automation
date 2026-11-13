'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/api/client';
import { useMe } from '@/lib/api/hooks';
import { ErrorState, LoadingBlock } from './states';

/**
 * API mode: renders the app only for a signed-in user and sends everyone else to /login.
 * (The session cookies are scoped to /bff, so this check is made through `GET /bff/auth/me`.)
 * Demo mode: pass-through.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const api = useApiClient();
  if (api.kind !== 'http') return <>{children}</>;
  return <HttpAuthGate>{children}</HttpAuthGate>;
}

function HttpAuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const signedOut = me.isSuccess && me.data === null;

  useEffect(() => {
    // window.location (not usePathname) so the layout stays prerenderable under Cache Components.
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [signedOut, router]);

  if (me.isPending || signedOut)
    return <LoadingBlock rows={3} label="Checking your session" className="p-6" />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} className="m-6" />;
  return <>{children}</>;
}
