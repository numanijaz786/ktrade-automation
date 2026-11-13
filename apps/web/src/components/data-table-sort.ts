import type { Row } from '@tanstack/react-table';
import { Dec } from '@/lib/decimal';

/** TanStack `sortingFn` comparing decimal-string cell values exactly. */
export function decimalSort<T>(a: Row<T>, b: Row<T>, columnId: string): number {
  const x = a.getValue<string | null>(columnId);
  const y = b.getValue<string | null>(columnId);
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  try {
    return Dec.of(x).cmp(y);
  } catch {
    return String(x).localeCompare(String(y));
  }
}
