'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RiPulseLine, RiSearch2Line, RiWifiOffLine } from '@remixicon/react';

import { Chip } from '@/components/base/badges/chip';
import { InputBase } from '@/components/base/input/input';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@/components/base/segmented-control/segmented-control';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@/components/base/table/table';
import { LoadingState } from '@/components/ai/loading-state';
import { SubagentPeekButton } from '@/components/chat/subagent-pane';
import { StatusDot } from '@/components/shared/status-dot';
import { useOrgChanges } from '@/hooks/use-org-changes';
import { cx } from '@/utils/cx';
import { formatDuration } from '@/utils/format';
import { type Run, type RunTone, TONE_TO_DOT, fetchRuns, statusTone } from './runs-data';

const POLL_MS = 15_000;

/** Map a run tone onto the BoardUI status Chip (the labeled Status column). */
type ChipColor = 'yellow' | 'lime' | 'rose' | 'soft';
const TONE_TO_CHIP: Record<RunTone, { color: ChipColor; label: string }> = {
  live: { color: 'yellow', label: 'Live' },
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
  const [query, setQuery] = React.useState('');
  // Show the pixel-matrix loader only when SSR handed us nothing to render and
  // the first client poll is still in flight.
  const [loading, setLoading] = React.useState(
    initialRuns.length === 0 && !initialError,
  );

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

  const q = query.trim().toLowerCase();
  const filtered = runs.filter((run) => {
    if (filter !== 'all' && statusTone(run.status) !== filter) return false;
    if (!q) return true;
    return (
      (run.prompt || '').toLowerCase().includes(q) ||
      (run.summary || '').toLowerCase().includes(q)
    );
  });

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
        <>
          {/* Toolbar: status tabs (left) + prompt/summary search (right). */}
          <div className='mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
            <SegmentedControl
              aria-label='Filter runs by status'
              selectedKeys={[filter]}
              onSelectionChange={(keys) => {
                const next = [...(keys as Set<string>)][0];
                if (next) setFilter(next as FilterValue);
              }}
              className='w-full sm:w-auto'
            >
              {FILTERS.map((f) => (
                <SegmentedControlItem key={f.value} id={f.value} className='flex-1 sm:flex-none'>
                  {f.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>

            <InputBase
              size='small'
              aria-label='Search runs'
              placeholder='Search runs…'
              leadingIcon={RiSearch2Line}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              fieldClassName='sm:w-64'
            />
          </div>

          {filtered.length > 0 ? (
            <Table
              aria-label='Active runs'
              containerClassName='mt-3'
              className='min-w-[720px]'
              onRowAction={(key) => router.push(`/session/${String(key)}`)}
            >
              <TableHeader>
                <TableColumn isRowHeader>Run</TableColumn>
                <TableColumn>Engine</TableColumn>
                <TableColumn>
                  <span className='block text-right'>Duration</span>
                </TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>
                  <span className='sr-only'>Actions</span>
                </TableColumn>
              </TableHeader>
              <TableBody>
                {filtered.map((run) => {
                  const tone = statusTone(run.status);
                  const title = run.prompt || 'Untitled run';
                  const chip = TONE_TO_CHIP[tone];
                  return (
                    <TableRow
                      key={run.id}
                      id={run.id}
                      className='cursor-pointer hover:bg-background-primary-hover'
                    >
                      <TableCell className='max-w-[440px]'>
                        <div className='flex items-center gap-3'>
                          <StatusDot {...TONE_TO_DOT[tone]} />
                          <div className='min-w-0'>
                            <p className='truncate text-body-2-medium text-text-primary'>{title}</p>
                            {run.summary && (
                              <p className='mt-0.5 truncate text-caption-1-regular text-text-secondary'>
                                {run.summary}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className='w-0'>
                        {run.engine && (
                          <Chip variant='caption' color='soft'>
                            {run.engine}
                          </Chip>
                        )}
                      </TableCell>
                      <TableCell className='w-0 whitespace-nowrap text-right text-caption-1-regular tabular-nums text-text-tertiary'>
                        {formatDuration(run.duration_ms)}
                      </TableCell>
                      <TableCell className='w-0'>
                        <Chip variant='caption' color={chip.color} className='gap-1'>
                          <span
                            aria-hidden
                            className={cx(
                              'size-1.5 rounded-full bg-current',
                              tone === 'live' && 'animate-pulse',
                            )}
                          />
                          {chip.label}
                        </Chip>
                      </TableCell>
                      <TableCell className='w-0 pr-4'>
                        {/* Actions cell swallows presses so the peek button never
                            triggers row navigation. */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <SubagentPeekButton runId={run.id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className='mt-10 text-center text-body-2-regular text-text-tertiary'>
              No runs match this filter.
            </p>
          )}
        </>
      )}
    </div>
  );
}
