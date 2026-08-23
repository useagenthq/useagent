'use client';

import { BarListCard } from '@/components/application/charts/bar-list-card';
import { ComboChartCard } from '@/components/application/charts/combo-chart-card';
import { RadarChartCard } from '@/components/application/charts/radar-chart-card';
import { RadialChartCard } from '@/components/application/charts/radial-chart-card';
import { SankeyChartCard } from '@/components/application/charts/sankey-chart-card';
import { ScatterChartCard } from '@/components/application/charts/scatter-chart-card';
import type {
  EngineFlow,
  ScatterSeriesData,
  StatusSlice,
  WeekComboPoint,
  WeekdayPoint,
} from './dashboard-data';

const count = (n: number) => String(Math.round(n));
const percent = (n: number) => `${Math.round(n)}%`;
const minutes = (n: number) =>
  n >= 60 ? `${Math.floor(n / 60)}h ${Math.round(n % 60)}m` : `${Math.round(n * 10) / 10}m`;
const hourOfDay = (n: number) => `${String(Math.floor(n)).padStart(2, '0')}:00`;

/**
 * The analytics band: six BoardUI chart cards fed exclusively with real run
 * aggregates derived server-side in dashboard-data.ts. Client component
 * because the cards are interactive and format functions cannot cross the RSC
 * boundary. A card with nothing real to show renders nothing - never demo data.
 */
export function AnalyticsBand({
  combo,
  status,
  flow,
  durations,
  repos,
  weekdays,
}: {
  combo: WeekComboPoint[];
  status: StatusSlice[];
  flow: EngineFlow;
  durations: ScatterSeriesData[];
  repos: { label: string; value: number }[];
  weekdays: WeekdayPoint[];
}) {
  const weekdayActivity = weekdays.some((d) => d.current > 0 || d.previous > 0);
  return (
    <section className='flex flex-col gap-3'>
      <h2 className='text-headline-medium text-text-primary'>Analytics</h2>
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
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
        {status.length > 0 && (
          <RadialChartCard
            variant='rings'
            title='Run status'
            data={status}
            range='All time'
            format={count}
            tiles
          />
        )}
        {flow.links.length > 0 && (
          <SankeyChartCard
            title='Engine outcomes'
            nodes={flow.nodes}
            links={flow.links}
            axisLabels={['Engine', 'Outcome']}
            range='All time'
            format={count}
          />
        )}
        {durations.length > 0 && (
          <ScatterChartCard
            title='Run durations'
            series={durations}
            axisLabels={['Hour of day', 'Duration']}
            range='Last 14 days'
            format={minutes}
            formatX={hourOfDay}
            tiles
          />
        )}
        {repos.length > 0 && (
          <BarListCard title='Runs by repository' items={repos} metricLabel='Runs' format={count} />
        )}
        {weekdayActivity && (
          <RadarChartCard
            title='Weekly rhythm'
            data={weekdays}
            series={[
              { key: 'current', label: 'This week' },
              { key: 'previous', label: 'Last week' },
            ]}
            range='This week vs last'
            format={count}
          />
        )}
      </div>
    </section>
  );
}
