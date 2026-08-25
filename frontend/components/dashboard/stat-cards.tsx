import * as React from 'react';

import { cx } from '@/utils/cx';
import { Card } from './card';

export interface StatItem {
  label: string;
  value: string;
  /** Optional trailing signal, e.g. "3 live" or "2 failed". */
  delta?: string;
  deltaColor?: 'lime' | 'rose' | 'gray' | 'blue';
}

/** Delta rendered as quiet colored text top-right of the cell (kobbe KPI strip),
 *  not a solid badge - the only colour the strip carries. */
const DELTA_TONE: Record<NonNullable<StatItem['deltaColor']>, string> = {
  lime: 'text-status-lime-text',
  rose: 'text-status-rose-text',
  blue: 'text-status-blue-text',
  gray: 'text-text-tertiary',
};

/** One KPI cell - muted label + optional delta top-right, big value below.
 *  Exported so the page can stream late-arriving cells into the same strip. */
export function StatCard({ stat }: { stat: StatItem }) {
  return (
    <div className='flex min-w-0 flex-1 flex-col gap-1 px-4 py-3'>
      <div className='flex items-start justify-between gap-2'>
        <p className='truncate text-body-2-regular text-text-secondary'>{stat.label}</p>
        {stat.delta && (
          <span
            className={cx(
              'shrink-0 whitespace-nowrap text-caption-1-medium tabular-nums',
              DELTA_TONE[stat.deltaColor ?? 'gray'],
            )}
          >
            {stat.delta}
          </span>
        )}
      </div>
      <p className='whitespace-nowrap text-headline-medium font-semibold tracking-[-0.1px] tabular-nums text-text-primary'>
        {stat.value}
      </p>
    </div>
  );
}

/** Skeleton cell shown while a streamed stat resolves. */
export function StatCardSkeleton() {
  return (
    <div className='flex-1 px-4 py-3' aria-hidden>
      <div className='h-[52px] animate-pulse rounded-lg bg-background-secondary-default/60' />
    </div>
  );
}

/**
 * KPI summary strip: one surface of metric cells with hairline separators
 * between them (kobbe overview grammar) - no icon boxes, no per-cell cards.
 * `children` lets the page append streamed cells into the same strip.
 */
export function StatCards({ stats, children }: { stats: StatItem[]; children?: React.ReactNode }) {
  return (
    <Card className='flex-col divide-y divide-border-button-default p-0 md:flex-row md:divide-x md:divide-y-0'>
      {stats.map((stat) => (
        <StatCard key={stat.label} stat={stat} />
      ))}
      {children}
    </Card>
  );
}
