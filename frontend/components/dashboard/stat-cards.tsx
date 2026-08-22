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
          <span className='flex size-9 items-center justify-center rounded-lg bg-background-secondary-default ring-1 ring-inset ring-border-button-default'>
            <stat.icon className='size-5 text-text-secondary' />
          </span>
          <div className='flex flex-col gap-1'>
            <p className='text-body-2-regular text-text-secondary'>{stat.label}</p>
            <div className='flex flex-wrap items-center gap-2'>
              <p className='whitespace-nowrap text-headline-medium font-semibold tracking-[-0.1px] tabular-nums text-text-primary'>
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
