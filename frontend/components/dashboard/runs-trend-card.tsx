'use client';

import * as React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  type TooltipProps,
} from 'recharts';

import * as Badge from '@/components/ui/badge';
import { Card } from './card';
import type { DayBucket } from './dashboard-data';

function TrendTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const bucket = payload[0]?.payload as DayBucket | undefined;
  if (!bucket) return null;
  return (
    <div className='rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-xs shadow-tooltip ring-1 ring-inset ring-stroke-soft-200'>
      <p className='mb-1 text-label-xs text-text-strong-950'>{bucket.label}</p>
      <p className='text-text-sub-600'>
        {bucket.total} {bucket.total === 1 ? 'run' : 'runs'}
      </p>
    </div>
  );
}

/**
 * "Token throughput" — revenue-style trend. Filled area + line over the last
 * 14 days of run volume, mirroring the finance-template area/line block. The
 * headline token figure is an estimate derived from run count (labelled as such).
 */
export function RunsTrendCard({
  data,
  tokensLabel,
}: {
  data: DayBucket[];
  tokensLabel: string;
}) {
  const gradientId = React.useId().replace(/:/g, '');
  return (
    <Card className='h-[329px] gap-4'>
      <div className='flex items-start justify-between'>
        <div className='flex flex-col gap-0.5'>
          <p className='text-paragraph-sm text-text-sub-600'>Token throughput</p>
          <div className='flex items-center gap-2'>
            <p className='text-title-h5 tabular-nums text-text-strong-950'>{tokensLabel}</p>
            <Badge.Root variant='lighter' color='gray'>
              est.
            </Badge.Root>
          </div>
        </div>
        <span className='text-paragraph-xs text-text-soft-400'>Last 14 days</span>
      </div>

      <div className='h-[220px] w-full [&_.recharts-cartesian-axis-tick_text]:fill-text-soft-400 [&_.recharts-surface]:outline-none'>
        <ResponsiveContainer width='100%' height='100%'>
          <ComposedChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
                <stop offset='0%' stopColor='hsl(var(--primary-base))' stopOpacity={0.28} />
                <stop offset='100%' stopColor='hsl(var(--primary-base))' stopOpacity={0} />
              </linearGradient>
            </defs>
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
              interval='preserveStartEnd'
              minTickGap={16}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              content={<TrendTooltip />}
              cursor={{ stroke: 'hsl(var(--stroke-sub-300))', strokeWidth: 1, strokeDasharray: '4 4' }}
            />
            <Area
              type='monotone'
              dataKey='total'
              stroke='none'
              fill={`url(#${gradientId})`}
              isAnimationActive
              animationDuration={450}
            />
            <Line
              type='monotone'
              dataKey='total'
              stroke='hsl(var(--primary-base))'
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: 'hsl(var(--primary-base))', stroke: 'hsl(var(--bg-white-0))', strokeWidth: 2 }}
              isAnimationActive
              animationDuration={450}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
