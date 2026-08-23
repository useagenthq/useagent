'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SortDescriptor } from 'react-aria-components';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { ColumnDef, PaginationState, SortingState } from '@tanstack/react-table';
import {
  Muted,
  SortChevron,
  StatusChip,
  type StatusChipColor,
} from '@/components/application/data-table/cells';
import { Chip } from '@/components/base/badges/chip';
import { Pagination } from '@/components/base/pagination/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@/components/base/table/table';
import { cx } from '@/utils/cx';
import { formatDuration, relativeTime } from '@/utils/format';
import { Card } from './card';
import { type DashRun, type RunStatus, timestamp } from './dashboard-data';

/**
 * Recent-runs card on the BoardUI data-table recipe: react-aria `Table`
 * rendered from a @tanstack/react-table instance (see
 * components/application/data-table). TanStack owns started-at sorting +
 * pagination; rows navigate to the run's session. Data arrives server-side
 * from the page's /api/runs snapshot and refreshes via DashboardLiveRefresh.
 */

const STATUS_CHIP: Record<RunStatus, { color: StatusChipColor; label: string; pulse?: boolean }> = {
  running: { color: 'yellow', label: 'Running', pulse: true },
  completed: { color: 'lime', label: 'Completed' },
  failed: { color: 'rose', label: 'Failed' },
  queued: { color: 'soft', label: 'Queued' },
};

const PER_PAGE = 8;

const COLUMNS: ColumnDef<DashRun>[] = [
  {
    id: 'run',
    enableSorting: false,
    header: 'Run',
    cell: ({ row }) => (
      <span className='block max-w-[320px] truncate text-body-2-medium text-text-primary'>
        {row.original.prompt || 'Untitled run'}
      </span>
    ),
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
      const chip = STATUS_CHIP[row.original.status];
      return <StatusChip color={chip.color} label={chip.label} pulse={chip.pulse} />;
    },
  },
  {
    id: 'started',
    accessorFn: (run) => timestamp(run.created_at),
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
];

const COL_WIDTHS: Record<string, string> = {
  engine: 'w-[120px]',
  repo: 'w-[200px]',
  status: 'w-[132px]',
  started: 'w-[112px]',
  duration: 'w-[104px]',
};

export function RecentRunsTable({ runs }: { runs: DashRun[] }) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'started', desc: true }]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PER_PAGE,
  });

  const table = useReactTable({
    data: runs,
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

  return (
    <Card className={cx('gap-0 p-0', totalPages <= 1 && 'pb-2')}>
      <div className='flex items-center justify-between p-4'>
        <div className='flex flex-col gap-0.5'>
          <p className='text-body-medium text-text-primary'>Recent runs</p>
          <p className='text-caption-1-regular text-text-secondary'>
            Latest agent activity across the fleet.
          </p>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className='flex h-40 items-center justify-center px-4 pb-4'>
          <p className='text-body-2-regular text-text-tertiary'>No runs yet.</p>
        </div>
      ) : (
        <>
          <Table
            aria-label='Recent runs'
            size='sm'
            className='min-w-[760px]'
            sortDescriptor={sortDescriptor}
            onSortChange={(descriptor) => {
              setSorting([{ id: String(descriptor.column), desc: descriptor.direction === 'descending' }]);
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
            <TableBody>
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

          {totalPages > 1 && (
            <div className='px-4 py-3'>
              <Pagination
                page={pagination.pageIndex + 1}
                totalPages={totalPages}
                onChange={(p) => table.setPageIndex(p - 1)}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
