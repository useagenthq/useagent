import * as React from 'react';

import { cnExt } from '@/utils/cn';

/**
 * Shared dashboard card chrome (mirrors the AlignUI finance-template WidgetBox):
 * a soft-ringed white surface that flips correctly on the dark #20201f ladder.
 * One card primitive for every dashboard section so the surface stays uniform.
 */
export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cnExt(
        'flex min-w-0 flex-col rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200',
        className,
      )}
      {...rest}
    />
  );
}
