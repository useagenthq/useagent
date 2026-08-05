// AlignUI FileFormatIcon v0.0.0

import * as React from 'react';

import { tv, type VariantProps } from '@/utils/tv';

export const fileFormatIconVariants = tv({
  slots: {
    root: 'relative shrink-0',
    formatBox:
      'absolute bottom-1.5 left-0 flex h-4 items-center rounded px-[3px] py-0.5 text-[11px] font-semibold leading-none text-static-white',
  },
  variants: {
    size: {
      medium: {
        root: 'size-10',
      },
      small: {
        root: 'size-8',
      },
    },
    color: {
      red: {
        formatBox: 'bg-error-base',
      },
      orange: {
        formatBox: 'bg-warning-base',
      },
      yellow: {
        formatBox: 'bg-away-base',
      },
      green: {
        formatBox: 'bg-success-base',
      },
      sky: {
        formatBox: 'bg-verified-base',
      },
      blue: {
        formatBox: 'bg-information-base',
      },
      purple: {
        formatBox: 'bg-feature-base',
      },
      pink: {
        formatBox: 'bg-highlighted-base',
      },
      gray: {
        formatBox: 'bg-faded-base',
      },
    },
  },
  defaultVariants: {
    color: 'gray',
    size: 'medium',
  },
});

function FileFormatIcon({
  format,
  className,
  color,
  size,
  ...rest
}: VariantProps<typeof fileFormatIconVariants> &
  React.SVGProps<SVGSVGElement>) {
  const { root, formatBox } = fileFormatIconVariants({ color, size });

  return (
    <svg
      width='40'
      height='40'
      viewBox='0 0 40 40'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      className={root({ class: className })}
      {...rest}
    >
      <path
        d='M30 39.25H10C7.10051 39.25 4.75 36.8995 4.75 34V6C4.75 3.10051 7.10051 0.75 10 0.75H20.5147C21.9071 0.75 23.2425 1.30312 24.227 2.28769L33.7123 11.773C34.6969 12.7575 35.25 14.0929 35.25 15.4853V34C35.25 36.8995 32.8995 39.25 30 39.25Z'
        className='fill-bg-white-0 stroke-stroke-sub-300'
        strokeWidth='1.5'
      />
      <path
        d='M23 1V9C23 11.2091 24.7909 13 27 13H35'
        className='stroke-stroke-sub-300'
        strokeWidth='1.5'
      />
      <foreignObject x='0' y='0' width='40' height='40'>
        {/* @ts-ignore */}
        <div xmlns='http://www.w3.org/1999/xhtml' className={formatBox()}>
          {format}
        </div>
      </foreignObject>
    </svg>
  );
}

export { FileFormatIcon as Root };
