// AlignUI AvatarGroup v0.0.0

import * as React from 'react';

import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';

import { AVATAR_ROOT_NAME } from './avatar';

const AVATAR_GROUP_ROOT_NAME = 'AvatarGroupRoot';
const AVATAR_GROUP_OVERFLOW_NAME = 'AvatarGroupOverflow';

export const avatarGroupVariants = tv({
  slots: {
    root: 'flex *:ring-2 *:ring-stroke-white-0',
    overflow:
      'relative flex shrink-0 items-center justify-center rounded-full bg-bg-weak-50 text-center text-text-sub-600',
  },
  variants: {
    size: {
      '80': {
        root: '-space-x-4',
        overflow: 'size-20 text-title-h5',
      },
      '72': {
        root: '-space-x-4',
        overflow: 'size-[72px] text-title-h5',
      },
      '64': {
        root: '-space-x-4',
        overflow: 'size-16 text-title-h5',
      },
      '56': {
        root: '-space-x-4',
        overflow: 'size-14 text-title-h5',
      },
      '48': {
        root: '-space-x-3',
        overflow: 'size-12 text-title-h6',
      },
      '40': {
        root: '-space-x-3',
        overflow: 'size-10 text-label-md',
      },
      '32': {
        root: '-space-x-1.5',
        overflow: 'size-8 text-label-sm',
      },
      '24': {
        root: '-space-x-1',
        overflow: 'size-6 text-label-xs',
      },
      '20': {
        root: '-space-x-1',
        overflow: 'size-5 text-subheading-2xs',
      },
    },
  },
  defaultVariants: {
    size: '80',
  },
});

type AvatarGroupSharedProps = VariantProps<typeof avatarGroupVariants>;

type AvatarGroupRootProps = VariantProps<typeof avatarGroupVariants> &
  React.HTMLAttributes<HTMLDivElement>;

function AvatarGroupRoot({
  children,
  size,
  className,
  ...rest
}: AvatarGroupRootProps) {
  const uniqueId = React.useId();
  const { root } = avatarGroupVariants({ size });

  const sharedProps: AvatarGroupSharedProps = {
    size,
  };

  const extendedChildren = recursiveCloneChildren(
    children as React.ReactElement[],
    sharedProps,
    [AVATAR_ROOT_NAME, AVATAR_GROUP_OVERFLOW_NAME],
    uniqueId,
  );

  return (
    <div className={root({ class: className })} {...rest}>
      {extendedChildren}
    </div>
  );
}
AvatarGroupRoot.displayName = AVATAR_GROUP_ROOT_NAME;

function AvatarGroupOverflow({
  children,
  size,
  className,
  ...rest
}: AvatarGroupSharedProps & React.HTMLAttributes<HTMLDivElement>) {
  const { overflow } = avatarGroupVariants({ size });

  return (
    <div className={overflow({ class: className })} {...rest}>
      {children}
    </div>
  );
}
AvatarGroupOverflow.displayName = AVATAR_GROUP_OVERFLOW_NAME;

export { AvatarGroupRoot as Root, AvatarGroupOverflow as Overflow };
