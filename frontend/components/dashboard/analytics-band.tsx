'use client';

import { AreaChartCard } from '@/components/application/charts/area-chart-card';
import { ComboChartCard } from '@/components/application/charts/combo-chart-card';
import type { DayBucket, WeekComboPoint } from './dashboard-data';

const count = (n: number) => String(Math.round(n));
const percent = (n: number) => `${Math.round(n)}%`;

/**
 * The dashboard charts row: two friendly BoardUI cards on real run aggregates
 * derived server-side in dashboard-data.ts. Client component because the
 * cards are interactive and format functions cannot cross the RSC boundary.
 */
export function AnalyticsBand({ daily, combo }: { daily: DayBucket[]; combo: WeekComboPoint[] }) {
  const dayLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const points = daily.map((d) => ({
    label: d.key ? dayLabel.format(new Date(d.key)) : d.label,
    completed: d.completed,
    failed: d.failed,
  }));
  return (
    <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
      <AreaChartCard
        title='Runs settled'
        data={points}
        series={[
          {
            key: 'completed',
            label: 'Completed',
            color: 'var(--color-chart-7)',
            activeColor: 'var(--color-chart-7-active)',
          },
          {
            key: 'failed',
            label: 'Failed',
            color: 'var(--color-red-500)',
            activeColor: 'var(--color-red-600)',
          },
        ]}
        range='Last 14 days'
        format={count}
        tiles
      />
      <ComboChartCard
        title='Runs and success rate'
        data={combo}
        bar={{ key: 'runs', label: 'Runs', format: count }}
        line={{
          key: 'success',
          label: 'Success',
          format: percent,
          color: 'var(--color-chart-7)',
          activeColor: 'var(--color-chart-7-active)',
        }}
        range='Last 8 weeks'
      />
    </div>
  );
}
