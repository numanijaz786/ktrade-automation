'use client';

import { useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type Row,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, LoadingBlock } from './states';

export interface FacetFilter {
  columnId: string;
  label: string;
  options: { value: string; label: string }[];
}

export interface DataTableProps<T> {
  data: T[] | undefined;
  columns: ColumnDef<T, unknown>[];
  /** Accessible table name. */
  caption: string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  searchPlaceholder?: string;
  /** Hide the search box. */
  noSearch?: boolean;
  facets?: FacetFilter[];
  initialSorting?: SortingState;
  pageSize?: number;
  onRowClick?: (row: T) => void;
  getRowId?: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  dense?: boolean;
  rowClassName?: (row: Row<T>) => string | undefined;
}

const equalsFilter: FilterFn<unknown> = (row, columnId, value) => value === undefined || value === '__all' || String(row.getValue(columnId)) === value;

/**
 * Client-side table: global search, facet filters, sortable headers (aria-sort), pagination,
 * and loading / error / empty states. Server pagination plugs in via the same column defs.
 */
export function DataTable<T>({
  data,
  columns,
  caption,
  isLoading,
  error,
  onRetry,
  searchPlaceholder = 'Search…',
  noSearch,
  facets = [],
  initialSorting = [],
  pageSize = 10,
  onRowClick,
  getRowId,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  toolbar,
  footer,
  dense,
  rowClassName,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });

  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting, globalFilter, columnFilters, pagination },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId,
    filterFns: { equals: equalsFilter },
    defaultColumn: { filterFn: equalsFilter as FilterFn<T> },
    globalFilterFn: 'includesString',
  });

  const rows = table.getRowModel().rows;
  const total = table.getFilteredRowModel().rows.length;
  const { pageIndex } = table.getState().pagination;
  const pageCount = table.getPageCount();

  return (
    <div className="space-y-3">
      {(!noSearch || facets.length > 0 || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {!noSearch && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={globalFilter}
                onChange={(e) => {
                  setGlobalFilter(e.target.value);
                  table.setPageIndex(0);
                }}
                placeholder={searchPlaceholder}
                aria-label={`Search ${caption}`}
                className="pl-8"
              />
            </div>
          )}
          {facets.map((f) => (
            <Select
              key={f.columnId}
              value={(table.getColumn(f.columnId)?.getFilterValue() as string | undefined) ?? '__all'}
              onValueChange={(v) => {
                table.getColumn(f.columnId)?.setFilterValue(v === '__all' ? undefined : v);
                table.setPageIndex(0);
              }}
            >
              <SelectTrigger aria-label={`Filter by ${f.label}`} className="w-full sm:w-44">
                <SelectValue placeholder={f.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All {f.label.toLowerCase()}</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      {isLoading ? (
        <LoadingBlock rows={Math.min(pageSize, 6)} label={`Loading ${caption}`} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table aria-label={caption}>
            <TableHeader className="bg-muted/40">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h) => {
                    const sorted = h.column.getIsSorted();
                    const align = (h.column.columnDef.meta as { align?: 'right' } | undefined)?.align;
                    return (
                      <TableHead
                        key={h.id}
                        aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : h.column.getCanSort() ? 'none' : undefined}
                        className={cn('h-9 text-xs whitespace-nowrap', align === 'right' && 'text-right')}
                      >
                        {h.isPlaceholder ? null : h.column.getCanSort() ? (
                          <button
                            type="button"
                            onClick={h.column.getToggleSortingHandler()}
                            className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', align === 'right' && 'flex-row-reverse')}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {sorted === 'asc' ? <ArrowUp className="size-3" aria-hidden="true" /> : sorted === 'desc' ? <ArrowDown className="size-3" aria-hidden="true" /> : <ArrowUpDown className="size-3 opacity-40" aria-hidden="true" />}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                    tabIndex={onRowClick ? 0 : undefined}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: 'right' } | undefined)?.align;
                      return (
                        <TableCell key={cell.id} className={cn('tabular', dense ? 'py-1.5' : 'py-2.5', align === 'right' && 'text-right')}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="p-4">
                    <EmptyState title={globalFilter || columnFilters.length ? 'No matches' : emptyTitle} description={globalFilter || columnFilters.length ? 'Try a different search or filter.' : emptyDescription} className="border-0" />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {footer}
          </Table>
        </div>
      )}

      {!isLoading && !error && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span aria-live="polite">
            {total} {total === 1 ? 'row' : 'rows'}
            {pageCount > 1 && ` · page ${pageIndex + 1} of ${pageCount}`}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sort decimal-string columns numerically without floats. */
export { decimalSort } from './data-table-sort';
