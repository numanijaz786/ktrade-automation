import type { ReactNode } from 'react';
import { AlertTriangle, Construction, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { errorMessage, isNotAvailable } from '@/lib/api/errors';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center',
        className,
      )}
    >
      <div className="text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className="size-8" />}
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

/** The feature's backend does not exist yet (ApiError NOT_AVAILABLE). Never replaced by demo data. */
export function NotAvailableState({ feature, className }: { feature?: string; className?: string }) {
  return (
    <div
      role="status"
      data-testid="not-available"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center',
        className,
      )}
    >
      <Construction className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">Not available yet — coming in a later phase</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {feature ? `${feature} has` : 'This feature has'} no backend yet. No sample or simulated data is shown
        in its place.
      </p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  if (isNotAvailable(error)) return <NotAvailableState className={className} />;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center',
        className,
      )}
    >
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="font-medium">Couldn’t load this data</p>
      <p className="max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function LoadingBlock({
  rows = 4,
  className,
  label = 'Loading',
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** Render loading / error / content for a query result. */
export function QueryState<T>({
  query,
  children,
  loading,
  rows,
}: {
  query: {
    data: T | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  rows?: number;
}) {
  if (query.isPending) return <>{loading ?? <LoadingBlock rows={rows} />}</>;
  if (query.isError || query.data === undefined)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
