'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RiPulseLine, RiSearch2Line, RiWifiOffLine } from '@remixicon/react';
import type { SortDescriptor } from 'react-aria-components';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { ColumnDef, PaginationState, SortingState } from '@tanstack/react-table';

import { LoadingState } from '@/components/ai/loading-state';
import {
  Muted,
  SortChevron,
  StatusChip,
  type StatusChipColor,
} from '@/components/application/data-table/cells';
import { Chip } from '@/components/base/badges/chip';
import { InputBase } from '@/components/base/input/input';
import { Pagination } from '@/components/base/pagination/pagination';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@/components/base/segmented-control/segmented-control';
import { Select, SelectItem } from '@/components/base/select/select';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@/components/base/table/table';
import { SubagentPeekButton } from '@/components/chat/subagent-pane';
import { StatusDot } from '@/components/shared/status-dot';
import { useOrgChanges } from '@/hooks/use-org-changes';
import { cx } from '@/utils/cx';
import { formatDuration, relativeTime } from '@/utils/format';
import { type Run, type RunTone, TONE_TO_DOT, fetchRuns, statusTone } from './runs-data';

const POLL_MS = 15_000;
const PER_PAGE = 10;

/** Map a run tone onto the shared StatusChip (the labeled Status column). */
const TONE_TO_CHIP: Record<RunTone, { color: StatusChipColor; label: string; pulse?: boolean }> = {
  live: { color: 'yellow', label: 'Live', pulse: true },
  success: { color: 'lime', label: 'Completed' },
  error: { color: 'rose', label: 'Failed' },
  idle: { color: 'soft', label: 'Queued' },
};

/** Toolbar tabs — client-side filter on run status tone ('all' = no filter). */
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'success', label: 'Completed' },
  { value: 'error', label: 'Failed' },
] as const;
type FilterValue = (typeof FILTERS)[number]['value'];

export function validEngineFilter(selected: string, engines: readonly string[]): string {
  return selected === 'all' || engines.includes(selected) ? selected : 'all';
}

/**
 * Active runs on the BoardUI data-table recipe: the react-aria `Table` primitive
 * driven by a @tanstack/react-table instance (shared cells live in
 * components/application/data-table/cells). TanStack owns started-at sorting +
 * pagination; the toolbar filters the FULL run set before it reaches the table,
 * so pagination always spans the filtered result. Rows navigate to the session.
 */
const COLUMNS: ColumnDef<Run>[] = [
  {
    id: 'run',
    enableSorting: false,
    header: 'Run',
    cell: ({ row }) => {
      const run = row.original;
      return (
        <div className='flex max-w-[440px] items-center gap-3'>
          <StatusDot {...TONE_TO_DOT[statusTone(run.status)]} />
          <div className='min-w-0'>
            <p className='truncate text-body-2-medium text-text-primary'>
              {run.prompt || 'Untitled run'}
            </p>
            {run.summary && (
              <p className='mt-0.5 truncate text-caption-1-regular text-text-secondary'>
                {run.summary}
              </p>
            )}
          </div>
        </div>
      );
    },
  },
  {
    id: 'engine',
    enableSorting: false,
    header: 'Engine',
    cell: ({ row }) =>
      row.original.engine ? (
        <Chip variant='caption' color='soft'>
          {row.original.engine}
        </Chip>
      ) : (
        <Muted />
      ),
  },
  {
    id: 'repo',
    enableSorting: false,
    header: 'Repository',
    cell: ({ row }) =>
      row.original.repo ? (
        <span className='block max-w-[200px] truncate text-body-2-regular text-text-secondary'>
          {row.original.repo}
        </span>
      ) : (
        <Muted />
      ),
  },
  {
    id: 'status',
    enableSorting: false,
    header: 'Status',
    cell: ({ row }) => {
      const chip = TONE_TO_CHIP[statusTone(row.original.status)];
      return <StatusChip color={chip.color} label={chip.label} pulse={chip.pulse} />;
    },
  },
  {
    id: 'started',
    // ISO 8601 strings sort lexically in chronological order, so the raw
    // created_at doubles as the numeric-equivalent sort key.
    accessorFn: (run) => run.created_at,
    header: 'Started',
    cell: ({ row }) => (
      <span className='block whitespace-nowrap text-right text-body-2-regular text-text-tertiary'>
        {relativeTime(row.original.created_at)}
      </span>
    ),
  },
  {
    id: 'duration',
    enableSorting: false,
    header: 'Duration',
    cell: ({ row }) => (
      <span className='block text-right text-body-2-regular tabular-nums text-text-secondary'>
        {formatDuration(row.original.duration_ms)}
      </span>
    ),
  },
  {
    id: 'actions',
    enableSorting: false,
    header: () => <span className='sr-only'>Actions</span>,
    cell: ({ row }) => (
      // Swallow presses so the peek button never triggers row navigation.
      <div
        className='flex justify-end'
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SubagentPeekButton runId={row.original.id} />
      </div>
    ),
  },
];

const COL_WIDTHS: Record<string, string> = {
  engine: 'w-[120px]',
  repo: 'w-[200px]',
  status: 'w-[132px]',
  started: 'w-[112px]',
  duration: 'w-[104px]',
  actions: 'w-[76px]',
};

function EmptyState() {
  return (
    <div className='mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-button-default px-6 py-16 text-center'>
      <RiPulseLine className='size-6 text-foreground-icon-tertiary' aria-hidden />
      <p className='mt-3 text-body-2-medium text-text-primary'>No active runs yet</p>
      <p className='mt-1 max-w-xs text-body-2-regular text-text-secondary'>
        New agent runs will appear here as they start.
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className='mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-button-default px-6 py-16 text-center'>
      <RiWifiOffLine className='size-6 text-foreground-icon-tertiary' aria-hidden />
      <p className='mt-3 text-body-2-medium text-text-primary'>
        Couldn&apos;t reach the runs service
      </p>
      <p className='mt-1 max-w-sm text-body-2-regular text-text-secondary'>
        Make sure the backend is running on port 3201. Retrying every 15s…
      </p>
    </div>
  );
}

export function RunsList({
  initialRuns,
  initialError,
}: {
  initialRuns: Run[];
  initialError: boolean;
}) {
  const router = useRouter();
  const [runs, setRuns] = React.useState<Run[]>(initialRuns);
  const [errored, setErrored] = React.useState(initialError);
  const [filter, setFilter] = React.useState<FilterValue>('all');
  const [engineFilter, setEngineFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  // Show the pixel-matrix loader only when SSR handed us nothing to render and
  // the first client poll is still in flight.
  const [loading, setLoading] = React.useState(
    initialRuns.length === 0 && !initialError,
  );
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'started', desc: true }]);
  const [pagination, setPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: PER_PAGE,
  });

  const load = React.useCallback(async (signal?: AbortSignal) => {
      try {
        const next = await fetchRuns(signal);
        setRuns(next);
        setErrored(false);
      } catch {
        if (signal?.aborted) return;
        setErrored(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
  }, []);

  useOrgChanges((change) => {
    if (change.type === 'run') void load();
  });

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => void load(controller.signal), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load]);

  // Keep the last good list on transient failures; only surface the error
  // panel when a poll failed and we have nothing to show.
  const showError = errored && runs.length === 0;
  const showLoading = !showError && loading && runs.length === 0;
  const showEmpty = !showError && !showLoading && runs.length === 0;

  // Engine filter options come from the data itself, so the select never
  // advertises an engine the org has no runs for.
  const engines = React.useMemo(
    () => [...new Set(runs.map((run) => run.engine).filter((e): e is string => !!e))].toSorted(),
    [runs],
  );

  React.useEffect(() => {
    const next = validEngineFilter(engineFilter, engines);
    if (next === engineFilter) return;
    setEngineFilter(next);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }, [engineFilter, engines]);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      runs.filter((run) => {
        if (filter !== 'all' && statusTone(run.status) !== filter) return false;
        if (engineFilter !== 'all' && run.engine !== engineFilter) return false;
        if (!q) return true;
        return (
          (run.prompt || '').toLowerCase().includes(q) ||
          (run.summary || '').toLowerCase().includes(q)
        );
      }),
    [runs, filter, engineFilter, q],
  );

  const table = useReactTable({
    data: filtered,
    columns: COLUMNS,
    getRowId: (run) => run.id,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const headers = table.getHeaderGroups()[0].headers;
  const rows = table.getRowModel().rows;
  const totalPages = table.getPageCount();
  const activeSort = sorting[0] ?? { id: 'started', desc: true };
  const sortDescriptor: SortDescriptor = {
    column: activeSort.id,
    direction: activeSort.desc ? 'descending' : 'ascending',
  };

  // Filtering / searching changes the row set, so jump back to the first page.
  const resetPage = () => table.setPageIndex(0);

  return (
    <div className='animate-ai-fade-up p-6 lg:p-8'>
      <div className='flex items-center justify-between'>
        <div>
          <p className='text-mono-label text-text-tertiary'>Agent</p>
          <h1 className='mt-1 text-display-4-medium text-text-primary'>Active runs</h1>
        </div>
        {runs.length > 0 && (
          <div className='flex items-center gap-2 text-caption-1-regular text-text-tertiary'>
            <span className='size-1.5 rounded-full bg-accent-500' aria-hidden />
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · live
          </div>
        )}
      </div>

      {showError && <ErrorState />}
      {showLoading && (
        <div className='flex justify-center py-16'>
          <LoadingState label='Loading runs' />
        </div>
      )}
      {showEmpty && <EmptyState />}

      {!showError && !showLoading && !showEmpty && (
        <section
          className={cx(
            'mt-6 flex w-full flex-col rounded-2xl border border-border-table pt-2',
            totalPages > 1 ? 'pb-3' : 'pb-0',
          )}
        >
          {/* Toolbar inside the card (data-table block recipe): result count on
              the left; status tabs, engine select, and the pill search right. */}
          <div className='flex w-full flex-col items-start gap-3 px-3 py-1 lg:flex-row lg:items-center lg:justify-between'>
            <div className='flex flex-col justify-center'>
              <p className='whitespace-nowrap text-body-2-regular text-text-tertiary'>Loaded results</p>
              <p className='whitespace-nowrap text-body-2-medium text-text-primary'>
                {filtered.length.toLocaleString()} of {runs.length.toLocaleString()} runs
              </p>
            </div>
            <div className='-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2.5 overflow-x-auto px-3 lg:mx-0 lg:w-auto lg:flex-wrap lg:justify-end lg:overflow-visible lg:px-0'>
              <SegmentedControl
                aria-label='Filter runs by status'
                selectedKeys={[filter]}
                onSelectionChange={(keys) => {
                  const next = [...(keys as Set<string>)][0];
                  if (next) {
                    setFilter(next as FilterValue);
                    resetPage();
                  }
                }}
                className='shrink-0'
              >
                {FILTERS.map((f) => (
                  <SegmentedControlItem key={f.value} id={f.value}>
                    {f.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>

              {engines.length > 1 && (
                <Select
                  aria-label='Filter by engine'
                  className='shrink-0'
                  popoverClassName='min-w-40'
                  selectedKey={engineFilter}
                  onSelectionChange={(k) => {
                    setEngineFilter(String(k));
                    resetPage();
                  }}
                >
                  <SelectItem id='all' textValue='All engines'>
                    All engines
                  </SelectItem>
                  {engines.map((engine) => (
                    <SelectItem key={engine} id={engine} textValue={engine}>
                      {engine}
                    </SelectItem>
                  ))}
                </Select>
              )}

              <InputBase
                aria-label='Search runs'
                placeholder='Search'
                leadingIcon={RiSearch2Line}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  resetPage();
                }}
                fieldClassName='min-w-[153px] flex-1 rounded-full bg-background-secondary-default lg:w-[200px] lg:min-w-0 lg:flex-none'
                className='text-body-2-regular'
              />
            </div>
          </div>

          <div className='mt-2'>
            <Table
              aria-label='Active runs'
              className='min-w-[900px]'
              sortDescriptor={sortDescriptor}
              onSortChange={(descriptor) => {
                setSorting([
                  {
                    id: String(descriptor.column),
                    desc: descriptor.direction === 'descending',
                  },
                ]);
              }}
              onRowAction={(key) => router.push(`/session/${String(key)}`)}
            >
              <TableHeader>
                {headers.map((header) => {
                  const id = header.column.id;
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <TableColumn
                      key={header.id}
                      id={header.id}
                      isRowHeader={id === 'run'}
                      allowsSorting={header.column.getCanSort()}
                      className={COL_WIDTHS[id]}
                    >
                      {header.column.getCanSort() ? (
                        <span className='flex w-full items-center justify-end gap-0.5'>
                          {label}
                          <SortChevron dir={header.column.getIsSorted()} />
                        </span>
                      ) : id === 'duration' ? (
                        <span className='block text-right'>{label}</span>
                      ) : (
                        label
                      )}
                    </TableColumn>
                  );
                })}
              </TableHeader>
              <TableBody
                renderEmptyState={() => (
                  <div className='flex h-40 items-center justify-center text-body-2-regular text-text-tertiary'>
                    No runs match this filter.
                  </div>
                )}
              >
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    id={row.id}
                    className='cursor-pointer hover:bg-background-primary-hover'
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className={COL_WIDTHS[cell.column.id]}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className='px-3 pt-3'>
              <Pagination
                page={pagination.pageIndex + 1}
                totalPages={totalPages}
                onChange={(p) => table.setPageIndex(p - 1)}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
