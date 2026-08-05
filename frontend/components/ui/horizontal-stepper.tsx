// AlignUI HorizontalStepper v0.0.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { RiArrowRightSLine } from '@remixicon/react';

import { cnExt } from '@/utils/cn';
import type { PolymorphicComponentProps } from '@/utils/polymorphic';
import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';

const HORIZONTAL_STEPPER_ROOT_NAME = 'HorizontalStepperRoot';
const HORIZONTAL_STEPPER_SEPARATOR_NAME = 'HorizontalStepperSeparator';
const HORIZONTAL_STEPPER_ITEM_NAME = 'HorizontalStepperItem';
const HORIZONTAL_STEPPER_ITEM_INDICATOR_NAME = 'HorizontalStepperItemIndicator';

function HorizontalStepperRoot({
  asChild,
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  asChild?: boolean;
}) {
  const Component = asChild ? Slot : 'div';

  return (
    <Component
      className={cnExt('flex flex-wrap justify-center gap-4', className)}
      {...rest}
    >
      {children}
    </Component>
  );
}
HorizontalStepperRoot.displayName = HORIZONTAL_STEPPER_ROOT_NAME;

function HorizontalStepperSeparatorIcon<T extends React.ElementType>({
  className,
  as,
  ...rest
}: PolymorphicComponentProps<T>) {
  const Component = as || RiArrowRightSLine;

  return (
    <Component
      className={cnExt('size-5 shrink-0 text-text-soft-400', className)}
      {...rest}
    />
  );
}
HorizontalStepperSeparatorIcon.displayName = HORIZONTAL_STEPPER_SEPARATOR_NAME;

const horizontalStepperItemVariants = tv({
  slots: {
    root: [
      // base
      'flex items-center gap-2 text-paragraph-sm',
    ],
    indicator: [
      // base
      'flex size-5 shrink-0 items-center justify-center rounded-full text-label-xs',
    ],
  },
  variants: {
    state: {
      completed: {
        root: 'text-text-strong-950',
        indicator: 'bg-success-base text-static-white',
      },
      active: {
        root: 'text-text-strong-950',
        indicator: 'bg-primary-base text-static-white',
      },
      default: {
        root: 'text-text-sub-600',
        indicator:
          'bg-bg-white-0 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200',
      },
    },
  },
  defaultVariants: {
    state: 'default',
  },
});

type HorizontalStepperItemSharedProps = VariantProps<
  typeof horizontalStepperItemVariants
>;

type HorizontalStepperItemProps =
  React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof horizontalStepperItemVariants> & {
      asChild?: boolean;
    };

const HorizontalStepperItem = React.forwardRef<
  HTMLButtonElement,
  HorizontalStepperItemProps
>(({ asChild, children, state, className, ...rest }, forwardedRef) => {
  const uniqueId = React.useId();
  const Component = asChild ? Slot : 'button';
  const { root } = horizontalStepperItemVariants({ state });

  const sharedProps: HorizontalStepperItemSharedProps = {
    state,
  };

  const extendedChildren = recursiveCloneChildren(
    children as React.ReactElement[],
    sharedProps,
    [HORIZONTAL_STEPPER_ITEM_INDICATOR_NAME],
    uniqueId,
    asChild,
  );

  return (
    <Component
      ref={forwardedRef}
      className={root({ class: className })}
      {...rest}
    >
      {extendedChildren}
    </Component>
  );
});
HorizontalStepperItem.displayName = HORIZONTAL_STEPPER_ITEM_NAME;

function HorizontalStepperItemIndicator({
  state,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & HorizontalStepperItemSharedProps) {
  const { indicator } = horizontalStepperItemVariants({ state });

  if (state === 'completed') {
    return (
      <div className={indicator({ class: className })} {...rest}>
        <svg viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg' fill='none'>
          <path
            fill='currentColor'
            d='M15.1 7.453 8.726 13.82 4.9 10l1.275-1.274 2.55 2.548 5.1-5.094L15.1 7.453Z'
          />
        </svg>
      </div>
    );
  }

  return (
    <div className={indicator({ class: className })} {...rest}>
      {children}
    </div>
  );
}
HorizontalStepperItemIndicator.displayName =
  HORIZONTAL_STEPPER_ITEM_INDICATOR_NAME;

export {
  HorizontalStepperRoot as Root,
  HorizontalStepperSeparatorIcon as SeparatorIcon,
  HorizontalStepperItem as Item,
  HorizontalStepperItemIndicator as ItemIndicator,
};
