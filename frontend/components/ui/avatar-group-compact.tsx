// AlignUI AvatarGroupCompact v0.0.0

import * as React from 'react';

import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';
import { AVATAR_ROOT_NAME } from '@/components/ui/avatar';

const AVATAR_GROUP_COMPACT_ROOT_NAME = 'AvatarGroupCompactRoot';
const AVATAR_GROUP_COMPACT_STACK_NAME = 'AvatarGroupCompactStack';
const AVATAR_GROUP_COMPACT_OVERFLOW_NAME = 'AvatarGroupCompactOverflow';

export const avatarGroupCompactVariants = tv({
  slots: {
    root: 'flex w-max items-center rounded-full bg-bg-white-0 p-0.5 shadow-regular-xs',
    stack: 'flex -space-x-0.5 *:ring-2 *:ring-stroke-white-0',
    overflow: 'text-text-sub-600',
  },
  variants: {
    variant: {
      default: {},
      stroke: {
        root: 'ring-1 ring-stroke-soft-200',
      },
    },
    size: {
      '40': {
        overflow: 'px-2.5 text-paragraph-md',
      },
      '32': {
        overflow: 'px-2 text-paragraph-sm',
      },
      '24': {
        overflow: 'px-1.5 text-paragraph-xs',
      },
    },
  },
  defaultVariants: {
    size: '40',
    variant: 'default',
  },
});

type AvatarGroupCompactSharedProps = VariantProps<
  typeof avatarGroupCompactVariants
>;

type AvatarGroupCompactRootProps = VariantProps<
  typeof avatarGroupCompactVariants
> &
  React.HTMLAttributes<HTMLDivElement>;

function AvatarGroupCompactRoot({
  children,
  size = '40',
  variant,
  className,
  ...rest
}: AvatarGroupCompactRootProps) {
  const uniqueId = React.useId();
  const { root } = avatarGroupCompactVariants({ size, variant });

  const sharedProps: AvatarGroupCompactSharedProps = {
    size,
  };

  const extendedChildren = recursiveCloneChildren(
    children as React.ReactElement[],
    sharedProps,
    [AVATAR_ROOT_NAME, AVATAR_GROUP_COMPACT_OVERFLOW_NAME],
    uniqueId,
  );

  return (
    <div className={root({ class: className })} {...rest}>
      {extendedChildren}
    </div>
  );
}
AvatarGroupCompactRoot.displayName = AVATAR_GROUP_COMPACT_ROOT_NAME;

function AvatarGroupCompactStack({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  const { stack } = avatarGroupCompactVariants();

  return (
    <div className={stack({ class: className })} {...rest}>
      {children}
    </div>
  );
}
AvatarGroupCompactStack.displayName = AVATAR_GROUP_COMPACT_STACK_NAME;

function AvatarGroupCompactOverflow({
  children,
  size,
  className,
  ...rest
}: AvatarGroupCompactSharedProps & React.HTMLAttributes<HTMLDivElement>) {
  const { overflow } = avatarGroupCompactVariants({ size });

  return (
    <div className={overflow({ class: className })} {...rest}>
      {children}
    </div>
  );
}
AvatarGroupCompactOverflow.displayName = AVATAR_GROUP_COMPACT_OVERFLOW_NAME;

export {
  AvatarGroupCompactRoot as Root,
  AvatarGroupCompactStack as Stack,
  AvatarGroupCompactOverflow as Overflow,
};
