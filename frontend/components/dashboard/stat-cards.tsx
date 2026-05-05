import * as React from 'react';

import * as Badge from '@/components/ui/badge';
import { Card } from './card';

export interface StatItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  /** Optional trailing chip, e.g. "3 live" or "+12%". */
  delta?: string;
  deltaColor?: 'green' | 'red' | 'gray' | 'blue';
}

/**
 * Four KPI cards: semantic icon tile, label, value, optional delta chip.
 * Structure ported from the Board UI dashboard, rebuilt on AlignUI tokens.
 */
export function StatCards({ stats }: { stats: StatItem[] }) {
  return (
    <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
      {stats.map((stat) => (
        <Card key={stat.label} className='h-[132px] justify-between'>
          <span className='flex size-9 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200'>
            <stat.icon className='size-5 text-text-sub-600' />
          </span>
          <div className='flex flex-col gap-1'>
            <p className='text-paragraph-sm text-text-sub-600'>{stat.label}</p>
            <div className='flex flex-wrap items-center gap-2'>
              <p className='whitespace-nowrap text-title-h5 tabular-nums text-text-strong-950'>
                {stat.value}
              </p>
              {stat.delta && (
                <Badge.Root variant='light' color={stat.deltaColor ?? 'gray'}>
                  {stat.delta}
                </Badge.Root>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
