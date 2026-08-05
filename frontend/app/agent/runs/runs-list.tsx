'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RiPulseLine, RiSearch2Line, RiWifiOffLine } from '@remixicon/react';

import * as Badge from '@/components/ui/badge';
import * as Input from '@/components/ui/input';
import * as SegmentedControl from '@/components/ui/segmented-control';
import * as StatusBadge from '@/components/ui/status-badge';
import * as Table from '@/components/ui/table';
import { LoadingState } from '@/components/ai/loading-state';
import { SubagentPeekButton } from '@/components/chat/subagent-pane';
import { StatusDot } from '@/components/shared/status-dot';
import { formatDuration } from '@/utils/format';
import { type Run, type RunTone, TONE_TO_DOT, fetchRuns, statusTone } from './runs-data';

const POLL_MS = 15_000;

/** Map a run tone onto the AlignUI StatusBadge (the labeled Status column). */
type BadgeStatus = 'completed' | 'pending' | 'failed' | 'disabled';
const TONE_TO_STATUS: Record<RunTone, { status: BadgeStatus; label: string }> = {
  live: { status: 'pending', label: 'Live' },
  success: { status: 'completed', label: 'Completed' },
  error: { status: 'failed', label: 'Failed' },
  idle: { status: 'disabled', label: 'Queued' },
};

/** Toolbar tabs — client-side filter on run status tone ('all' = no filter). */
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'success', label: 'Completed' },
  { value: 'error', label: 'Failed' },
] as const;
type FilterValue = (typeof FILTERS)[number]['value'];

/**
 * One table row = one run. The whole row navigates to the session (row onClick +
 * keyboard), while the trailing peek button stops propagation (it opens the run
 * in the temporary pane without navigating).
 */
function RunRow({ run }: { run: Run }) {
  const router = useRouter();
  const tone = statusTone(run.status);
  const href = `/session/${run.id}`;
  const title = run.prompt || 'Untitled run';
  const badge = TONE_TO_STATUS[tone];

  return (
    <Table.Row
      role='link'
      tabIndex={0}
      aria-label={`Open run: ${title}`}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          router.push(href);
        }
      }}
      className='cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50'
    >
      <Table.Cell className='max-w-[440px]'>
        <div className='flex items-center gap-3'>
          <StatusDot {...TONE_TO_DOT[tone]} />
          <div className='min-w-0'>
            <p className='truncate text-label-sm text-text-strong-950'>{title}</p>
            {run.summary && (
              <p className='mt-0.5 truncate text-paragraph-xs text-text-sub-600'>
                {run.summary}
              </p>
            )}
          </div>
        </div>
      </Table.Cell>
      <Table.Cell className='w-0'>
        {run.engine && (
          <Badge.Root variant='lighter' color='gray' size='medium'>
            {run.engine}
          </Badge.Root>
        )}
      </Table.Cell>
      <Table.Cell className='w-0 whitespace-nowrap text-right text-label-xs tabular-nums text-text-soft-400'>
        {formatDuration(run.duration_ms)}
      </Table.Cell>
      <Table.Cell className='w-0'>
        <StatusBadge.Root variant='light' status={badge.status}>
          <StatusBadge.Dot className={tone === 'live' ? 'animate-pulse' : undefined} />
          {badge.label}
        </StatusBadge.Root>
      </Table.Cell>
      <Table.Cell
        className='w-0 pr-4'
        onClick={(e) => e.stopPropagation()}
      >
        {/* Actions cell swallows clicks so the peek button never triggers row nav. */}
        <SubagentPeekButton runId={run.id} />
      </Table.Cell>
    </Table.Row>
  );
}

function EmptyState() {
  return (
    <div className='mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-stroke-soft-200 px-6 py-16 text-center'>
      <RiPulseLine className='size-6 text-text-soft-400' aria-hidden />
      <p className='mt-3 text-label-sm text-text-strong-950'>No active runs yet</p>
      <p className='mt-1 max-w-xs text-paragraph-sm text-text-sub-600'>
        New agent runs will appear here as they start.
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className='mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-stroke-soft-200 px-6 py-16 text-center'>
      <RiWifiOffLine className='size-6 text-text-soft-400' aria-hidden />
      <p className='mt-3 text-label-sm text-text-strong-950'>
        Couldn&apos;t reach the runs service
      </p>
      <p className='mt-1 max-w-sm text-paragraph-sm text-text-sub-600'>
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
  const [runs, setRuns] = React.useState<Run[]>(initialRuns);
  const [errored, setErrored] = React.useState(initialError);
  const [filter, setFilter] = React.useState<FilterValue>('all');
  const [query, setQuery] = React.useState('');
  // Show the pixel-matrix loader only when SSR handed us nothing to render and
  // the first client poll is still in flight.
  const [loading, setLoading] = React.useState(
    initialRuns.length === 0 && !initialError,
  );

  React.useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const next = await fetchRuns();
        if (cancelled) return;
        setRuns(next);
        setErrored(false);
      } catch {
        if (cancelled) return;
        setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
          <p className='text-mono-label text-text-soft-400'>Agent</p>
          <h1 className='mt-1 text-display-sm text-text-strong-950'>Active runs</h1>
        </div>
        {runs.length > 0 && (
          <div className='flex items-center gap-2 text-label-xs text-text-soft-400'>
            <span className='size-1.5 rounded-full bg-primary-base' aria-hidden />
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
            <SegmentedControl.Root
              value={filter}
              onValueChange={(v) => setFilter(v as FilterValue)}
            >
              <SegmentedControl.List className='w-full sm:w-[340px]'>
                {FILTERS.map((f) => (
                  <SegmentedControl.Trigger key={f.value} value={f.value}>
                    {f.label}
                  </SegmentedControl.Trigger>
                ))}
              </SegmentedControl.List>
            </SegmentedControl.Root>

            <Input.Root size='small' className='sm:w-64'>
              <Input.Wrapper>
                <Input.Icon as={RiSearch2Line} />
                <Input.Input
                  placeholder='Search runs…'
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>

          {filtered.length > 0 ? (
            <Table.Root className='mt-3 [&>table]:min-w-[720px]'>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Run</Table.Head>
                  <Table.Head>Engine</Table.Head>
                  <Table.Head className='text-right'>Duration</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>
                    <span className='sr-only'>Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((run, i, arr) => (
                  <React.Fragment key={run.id}>
                    <RunRow run={run} />
                    {i < arr.length - 1 && <Table.RowDivider />}
                  </React.Fragment>
                ))}
              </Table.Body>
            </Table.Root>
          ) : (
            <p className='mt-10 text-center text-paragraph-sm text-text-soft-400'>
              No runs match this filter.
            </p>
          )}
        </>
      )}
    </div>
  );
}
