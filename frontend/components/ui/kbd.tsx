// AlignUI Kbd v0.0.0

import * as React from 'react';

import { cnExt } from '@/utils/cn';

function Kbd({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cnExt(
        'flex h-5 items-center gap-0.5 whitespace-nowrap rounded bg-bg-white-0 px-1.5 text-subheading-xs text-text-soft-400 ring-1 ring-inset ring-stroke-soft-200',
        className,
      )}
      {...rest}
    />
  );
}

export { Kbd as Root };
