'use client';

import { AreaChartCard } from '@/components/application/charts/area-chart-card';
import { ComboChartCard } from '@/components/application/charts/combo-chart-card';
import type { DayBucket, WeekComboPoint } from './dashboard-data';

const count = (n: number) => String(Math.round(n));

/**
 * The dashboard charts row: two friendly BoardUI cards on real run aggregates
 * derived server-side in dashboard-data.ts. Client component because the
 * cards are interactive and format functions cannot cross the RSC boundary.
 */
export function AnalyticsBand({ daily, combo }: { daily: DayBucket[]; combo: WeekComboPoint[] }) {
  const points = daily.map((d) => ({
    label: d.label,
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
        title='Runs per week'
        data={combo}
        bar={{ key: 'runs', label: 'Runs', format: count }}
        line={null}
        range='Last 8 weeks'
      />
      <div className='sr-only'>
        <table>
          <caption>Runs settled by UTC day</caption>
          <thead><tr><th>Day</th><th>Completed</th><th>Failed</th></tr></thead>
          <tbody>{daily.map((row) => <tr key={row.key}><th>{row.label}</th><td>{row.completed}</td><td>{row.failed}</td></tr>)}</tbody>
        </table>
        <table>
          <caption>Runs created by UTC week</caption>
          <thead><tr><th>Week</th><th>Runs</th></tr></thead>
          <tbody>{combo.map((row) => <tr key={row.label}><th>{row.label}</th><td>{row.runs}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
