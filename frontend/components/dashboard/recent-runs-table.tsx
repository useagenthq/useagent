import * as Badge from '@/components/ui/badge';
import * as StatusBadge from '@/components/ui/status-badge';
import * as Table from '@/components/ui/table';
import { Card } from './card';
import { formatDuration, relativeTime } from '@/utils/format';
import { type DashRun, type RunStatus } from './dashboard-data';

const STATUS_MAP: Record<
  RunStatus,
  { status: 'completed' | 'pending' | 'failed' | 'disabled'; label: string }
> = {
  completed: { status: 'completed', label: 'Completed' },
  running: { status: 'pending', label: 'Running' },
  queued: { status: 'disabled', label: 'Queued' },
  failed: { status: 'failed', label: 'Failed' },
};

/**
 * Recent-runs table card (maps the Board UI customers table to agent runs):
 * prompt · status · engine · model · duration · when. Server-rendered on
 * AlignUI Table primitives.
 */
export function RecentRunsTable({ runs }: { runs: DashRun[] }) {
  return (
    <Card className='gap-0 p-0'>
      <div className='flex items-center justify-between p-4'>
        <div className='flex flex-col gap-0.5'>
          <p className='text-label-md text-text-strong-950'>Recent runs</p>
          <p className='text-paragraph-xs text-text-sub-600'>
            Latest agent activity across the fleet.
          </p>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className='flex h-40 items-center justify-center px-4 pb-4'>
          <p className='text-paragraph-sm text-text-soft-400'>No runs yet.</p>
        </div>
      ) : (
        <div className='px-4 pb-2'>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Prompt</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Engine</Table.Head>
                <Table.Head>Model</Table.Head>
                <Table.Head className='text-right'>Duration</Table.Head>
                <Table.Head className='text-right'>When</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {runs.map((run) => {
                const badge = STATUS_MAP[run.status];
                return (
                  <Table.Row key={run.id}>
                    <Table.Cell className='max-w-[320px]'>
                      <span className='block truncate text-label-sm text-text-strong-950'>
                        {run.prompt || 'Untitled run'}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge.Root variant='light' status={badge.status}>
                        <StatusBadge.Dot />
                        {badge.label}
                      </StatusBadge.Root>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge.Root
                        variant='lighter'
                        color={run.engine && run.engine !== 'mock' ? 'purple' : 'gray'}
                        className='capitalize'
                      >
                        {run.engine ?? '-'}
                      </Badge.Root>
                    </Table.Cell>
                    <Table.Cell>
                      <span className='whitespace-nowrap text-paragraph-sm text-text-sub-600'>
                        {run.model ?? '-'}
                      </span>
                    </Table.Cell>
                    <Table.Cell className='text-right'>
                      <span className='tabular-nums text-paragraph-sm text-text-sub-600'>
                        {formatDuration(run.duration_ms)}
                      </span>
                    </Table.Cell>
                    <Table.Cell className='text-right'>
                      <span className='whitespace-nowrap text-paragraph-sm text-text-soft-400'>
                        {relativeTime(run.created_at)}
                      </span>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </div>
      )}
    </Card>
  );
}
