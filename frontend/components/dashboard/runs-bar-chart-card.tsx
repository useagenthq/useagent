'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  type TooltipProps,
} from 'recharts';

import { Card } from './card';
import type { DayBucket } from './dashboard-data';

function BarTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const bucket = payload[0]?.payload as DayBucket | undefined;
  if (!bucket) return null;
  return (
    <div className='rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-xs shadow-tooltip ring-1 ring-inset ring-stroke-soft-200'>
      <p className='mb-1 text-label-xs text-text-strong-950'>{bucket.label}</p>
      <p className='text-text-sub-600'>
        {bucket.total} {bucket.total === 1 ? 'run' : 'runs'}
      </p>
      <p className='text-success-base'>{bucket.completed} completed</p>
      {bucket.failed > 0 && <p className='text-error-base'>{bucket.failed} failed</p>}
    </div>
  );
}

/**
 * "Runs this week" — earnings-style bar chart. Single series (runs/day) with a
 * faint column track and rounded caps, mirroring the finance-template bar block.
 */
export function RunsBarChartCard({ data, total }: { data: DayBucket[]; total: number }) {
  return (
    <Card className='h-[329px] gap-4'>
      <div className='flex items-start justify-between'>
        <div className='flex flex-col gap-0.5'>
          <p className='text-paragraph-sm text-text-sub-600'>Runs this week</p>
          <p className='text-label-lg font-semibold tracking-[-0.1px] tabular-nums text-text-strong-950'>{total}</p>
        </div>
        <span className='text-paragraph-xs text-text-soft-400'>Last 7 days</span>
      </div>

      <div className='h-[220px] w-full [&_.recharts-cartesian-axis-tick_text]:fill-text-soft-400 [&_.recharts-surface]:outline-none'>
        <ResponsiveContainer width='100%' height='100%'>
          <BarChart data={data} barCategoryGap='22%' margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid
              vertical={false}
              stroke='hsl(var(--stroke-soft-200))'
              strokeDasharray='3 3'
            />
            <XAxis
              dataKey='label'
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={{ fontSize: 12 }}
            />
            <Tooltip cursor={false} content={<BarTooltip />} />
            <Bar
              dataKey='total'
              fill='#0077E6'
              radius={[6, 6, 6, 6]}
              maxBarSize={28}
              background={{ fill: 'hsl(var(--bg-weak-50))', radius: 6 }}
              isAnimationActive
              animationDuration={450}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
