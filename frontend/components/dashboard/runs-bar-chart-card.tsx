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
    <div className='rounded-lg bg-background-primary-default px-3 py-2 text-caption-1-regular shadow-tooltip ring-1 ring-inset ring-border-button-default'>
      <p className='mb-1 text-caption-1-medium text-text-primary'>{bucket.label}</p>
      <p className='text-text-secondary'>
        {bucket.total} {bucket.total === 1 ? 'run' : 'runs'}
      </p>
      <p className='text-status-lime-text'>{bucket.completed} completed</p>
      {bucket.failed > 0 && <p className='text-text-error-primary'>{bucket.failed} failed</p>}
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
          <p className='text-body-2-regular text-text-secondary'>Runs this week</p>
          <p className='text-headline-medium font-semibold tracking-[-0.1px] tabular-nums text-text-primary'>{total}</p>
        </div>
        <span className='text-caption-1-regular text-text-tertiary'>Last 7 days</span>
      </div>

      <div className='h-[220px] w-full [&_.recharts-cartesian-axis-tick_text]:fill-text-tertiary [&_.recharts-surface]:outline-none'>
        <ResponsiveContainer width='100%' height='100%'>
          <BarChart data={data} barCategoryGap='22%' margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid
              vertical={false}
              stroke='var(--color-chart-track)'
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
              background={{ fill: 'var(--color-background-secondary-default)', radius: 6 }}
              isAnimationActive
              animationDuration={450}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
