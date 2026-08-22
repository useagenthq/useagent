import { cn } from '@/utils/cn';
import { Card } from './card';
import type { HeatCell } from './dashboard-data';

/** Single-hue intensity ramp — adapts to both themes via the primary token. */
const LEVEL: Record<HeatCell['level'], string> = {
  0: 'bg-background-secondary-default',
  1: 'bg-accent-500/25',
  2: 'bg-accent-500/45',
  3: 'bg-accent-500/70',
  4: 'bg-accent-500',
};

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function summarise(cells: HeatCell[][]) {
  const flat = cells.flat();
  const activeDays = flat.filter((c) => c.count > 0).length;
  const busiest = flat.reduce((max, c) => (c.count > max ? c.count : max), 0);
  return { activeDays, busiest };
}

/**
 * GitHub-style contributions heatmap of run activity. Structure ported from the
 * Board UI contributions card; rendered server-side (no chart lib) as a CSS grid
 * with a compact stats rail and an intensity legend.
 */
export function ContributionsCard({
  cells,
  total,
}: {
  cells: HeatCell[][];
  total: number;
}) {
  const { activeDays, busiest } = summarise(cells);
  const weeks = cells.length;

  return (
    <Card className='gap-4'>
      <div className='flex items-start justify-between gap-2'>
        <div className='flex flex-col gap-0.5'>
          <p className='text-body-2-regular text-text-secondary'>Run activity</p>
          <div className='flex items-center gap-2'>
            <p className='text-headline-medium font-semibold tracking-[-0.1px] tabular-nums text-text-primary'>{total}</p>
            <span className='text-caption-1-regular text-text-tertiary'>
              runs in the last {weeks} weeks
            </span>
          </div>
        </div>
      </div>

      <div className='flex flex-1 flex-wrap items-end justify-between gap-6'>
        {/* Heatmap: weekday rail + week columns */}
        <div className='flex gap-1.5 overflow-x-auto'>
          <div className='flex shrink-0 flex-col gap-1 pr-1'>
            {DAY_LABELS.map((label, i) => (
              <span
                key={i}
                className='flex h-3 items-center text-[10px] leading-none text-text-tertiary'
              >
                {label}
              </span>
            ))}
          </div>
          {cells.map((column, i) => (
            <div key={i} className='flex flex-col gap-1'>
              {column.map((cell) => (
                <span
                  key={cell.key}
                  title={`${cell.count} ${cell.count === 1 ? 'run' : 'runs'} · ${cell.key}`}
                  className={cn('size-3 rounded-[3px]', LEVEL[cell.level])}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Stats rail */}
        <dl className='flex gap-6'>
          <div className='flex flex-col gap-0.5'>
            <dt className='text-caption-1-regular text-text-tertiary'>Active days</dt>
            <dd className='text-headline-medium tabular-nums text-text-primary'>{activeDays}</dd>
          </div>
          <div className='flex flex-col gap-0.5'>
            <dt className='text-caption-1-regular text-text-tertiary'>Busiest day</dt>
            <dd className='text-headline-medium tabular-nums text-text-primary'>{busiest}</dd>
          </div>
        </dl>
      </div>

      {/* Legend */}
      <div className='flex items-center justify-end gap-1.5 text-caption-1-regular text-text-tertiary'>
        <span>Less</span>
        {([0, 1, 2, 3, 4] as const).map((l) => (
          <span key={l} className={cn('size-3 rounded-[3px]', LEVEL[l])} />
        ))}
        <span>More</span>
      </div>
    </Card>
  );
}
