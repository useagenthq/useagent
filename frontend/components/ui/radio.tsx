// AlignUI Radio v0.0.0

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';

import { cn, cnExt } from '@/utils/cn';

const RadioGroup = RadioGroupPrimitive.Root;
RadioGroup.displayName = 'RadioGroup';

const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...rest }, forwardedRef) => {
  const filterId = React.useId();

  return (
    <RadioGroupPrimitive.Item
      ref={forwardedRef}
      className={cnExt(
        'group/radio relative size-5 shrink-0 outline-none focus:outline-none',
        className,
      )}
      {...rest}
    >
      <svg
        width='20'
        height='20'
        viewBox='0 0 20 20'
        fill='none'
        xmlns='http://www.w3.org/2000/svg'
        className={cn([
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
        ])}
      >
        <circle
          cx='10'
          cy='10'
          r='8'
          className={cn(
            'fill-bg-soft-200 transition duration-200 ease-out',
            // hover
            'group-hover/radio:fill-bg-sub-300',
            // focus
            'group-focus/radio:fill-primary-base',
            // disabled
            'group-disabled/radio:fill-bg-soft-200',
            // disabled chcked
            'group-data-[state=checked]/radio:fill-bg-white-0',
          )}
        />
        <g filter={`url(#${filterId})`}>
          <circle
            cx='10'
            cy='10'
            r='6.5'
            className={cn(
              'fill-bg-white-0',
              // disabled
              'group-disabled/radio:hidden',
            )}
          />
        </g>
        <defs>
          <filter
            id={filterId}
            x='1.5'
            y='3.5'
            width='17'
            height='17'
            filterUnits='userSpaceOnUse'
            colorInterpolationFilters='sRGB'
          >
            <feFlood floodOpacity='0' result='BackgroundImageFix' />
            <feColorMatrix
              in='SourceAlpha'
              type='matrix'
              values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0'
              result='hardAlpha'
            />
            <feOffset dy='2' />
            <feGaussianBlur stdDeviation='1' />
            <feColorMatrix
              type='matrix'
              values='0 0 0 0 0.105882 0 0 0 0 0.109804 0 0 0 0 0.113725 0 0 0 0.12 0'
            />
            <feBlend
              mode='normal'
              in2='BackgroundImageFix'
              result='effect1_dropShadow_515_4243'
            />
            <feBlend
              mode='normal'
              in='SourceGraphic'
              in2='effect1_dropShadow_515_4243'
              result='shape'
            />
          </filter>
        </defs>
      </svg>

      <RadioGroupPrimitive.Indicator asChild>
        <svg
          width='20'
          height='20'
          viewBox='0 0 20 20'
          fill='none'
          xmlns='http://www.w3.org/2000/svg'
          className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
        >
          <circle
            cx='10'
            cy='10'
            r='6'
            strokeWidth='4'
            className={cn(
              'stroke-primary-base transition duration-200 ease-out',
              // hover
              'group-hover/radio:stroke-primary-darker',
              // focus
              'group-focus/radio:stroke-primary-dark',
              // disabled
              'group-disabled/radio:stroke-bg-soft-200',
            )}
          />
        </svg>
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
});
RadioGroupItem.displayName = 'RadioGroupItem';

export { RadioGroup as Group, RadioGroupItem as Item };
