// AlignUI DotStepper v0.0.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cnExt } from '@/utils/cn';
import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';

const DOT_STEPPER_ROOT_NAME = 'DotStepperRoot';
const DOT_STEPPER_ITEM_NAME = 'DotStepperItem';

export const dotStepperVariants = tv({
  slots: {
    root: 'flex flex-wrap',
    item: [
      // base
      'shrink-0 rounded-full bg-bg-soft-200 outline-none transition duration-200 ease-out',
      // focus
      'focus:outline-none',
      'focus-visible:ring-2 focus-visible:ring-stroke-strong-950',
    ],
  },
  variants: {
    size: {
      small: {
        root: 'gap-2.5',
        item: 'size-2',
      },
      xsmall: {
        root: 'gap-1.5',
        item: 'size-1',
      },
    },
  },
  defaultVariants: {
    size: 'small',
  },
});

type DotStepperSharedProps = VariantProps<typeof dotStepperVariants>;

type DotStepperRootProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof dotStepperVariants> & {
    asChild?: boolean;
  };

function DotStepperRoot({
  asChild,
  children,
  size,
  className,
  ...rest
}: DotStepperRootProps) {
  const uniqueId = React.useId();
  const Component = asChild ? Slot : 'div';
  const { root } = dotStepperVariants({ size });

  const sharedProps: DotStepperSharedProps = {
    size,
  };

  const extendedChildren = recursiveCloneChildren(
    children as React.ReactElement[],
    sharedProps,
    [DOT_STEPPER_ITEM_NAME],
    uniqueId,
    asChild,
  );

  return (
    <Component className={root({ class: className })} {...rest}>
      {extendedChildren}
    </Component>
  );
}
DotStepperRoot.displayName = DOT_STEPPER_ROOT_NAME;

type DotStepperItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  DotStepperSharedProps & {
    asChild?: boolean;
    active?: boolean;
  };

const DotStepperItem = React.forwardRef<HTMLButtonElement, DotStepperItemProps>(
  ({ asChild, size, className, active, ...rest }, forwardedRef) => {
    const Component = asChild ? Slot : 'button';
    const { item } = dotStepperVariants({ size });

    return (
      <Component
        ref={forwardedRef}
        className={cnExt(item({ class: className }), {
          'bg-primary-base': active,
        })}
        {...rest}
      />
    );
  },
);
DotStepperItem.displayName = DOT_STEPPER_ITEM_NAME;

export { DotStepperRoot as Root, DotStepperItem as Item };
