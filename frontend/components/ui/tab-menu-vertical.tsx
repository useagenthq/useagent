'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cnExt } from '@/utils/cn';
import { PolymorphicComponentProps } from '@/utils/polymorphic';

const TabMenuVerticalContent = TabsPrimitive.Content;
TabMenuVerticalContent.displayName = 'TabMenuVerticalContent';

type TabMenuVerticalRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>,
  'orientation'
>;

const TabMenuVerticalRoot = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  TabMenuVerticalRootProps
>(({ ...rest }, forwardedRef) => {
  return (
    <TabsPrimitive.Root ref={forwardedRef} orientation='vertical' {...rest} />
  );
});
TabMenuVerticalRoot.displayName = 'TabMenuVerticalRoot';

const TabMenuVerticalList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <TabsPrimitive.List
      ref={forwardedRef}
      className={cnExt('w-full space-y-2', className)}
      {...rest}
    />
  );
});
TabMenuVerticalList.displayName = 'TabMenuVerticalList';

const TabMenuVerticalTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <TabsPrimitive.Trigger
      ref={forwardedRef}
      className={cnExt(
        // base
        'group/tab-item w-full rounded-lg p-2 text-left text-label-sm text-text-sub-600 outline-none',
        'grid auto-cols-auto grid-flow-col grid-cols-[auto,minmax(0,1fr)] items-center gap-1.5',
        'transition duration-200 ease-out',
        // hover
        'hover:bg-bg-weak-50',
        // focus
        'focus:outline-none',
        // active
        'data-[state=active]:bg-bg-weak-50 data-[state=active]:text-text-strong-950',
        className,
      )}
      {...rest}
    />
  );
});
TabMenuVerticalTrigger.displayName = 'TabMenuVerticalTrigger';

function TabMenuVerticalIcon<T extends React.ElementType>({
  className,
  as,
  ...rest
}: PolymorphicComponentProps<T>) {
  const Component = as || 'div';

  return (
    <Component
      className={cnExt(
        // base
        'size-5 text-text-sub-600',
        'transition duration-200 ease-out',
        // active
        'group-data-[state=active]/tab-item:text-primary-base',
        className,
      )}
      {...rest}
    />
  );
}
TabMenuVerticalIcon.displayName = 'TabsVerticalIcon';

function TabMenuVerticalArrowIcon<T extends React.ElementType>({
  className,
  as,
  ...rest
}: PolymorphicComponentProps<T>) {
  const Component = as || 'div';

  return (
    <Component
      className={cnExt(
        // base
        'size-5 p-px text-text-sub-600',
        'rounded-full bg-bg-white-0 opacity-0 shadow-regular-xs',
        'scale-75 transition ease-out',
        // active
        'group-data-[state=active]/tab-item:scale-100 group-data-[state=active]/tab-item:opacity-100',
        className,
      )}
      {...rest}
    />
  );
}
TabMenuVerticalArrowIcon.displayName = 'TabMenuVerticalArrowIcon';

export {
  TabMenuVerticalRoot as Root,
  TabMenuVerticalList as List,
  TabMenuVerticalTrigger as Trigger,
  TabMenuVerticalIcon as Icon,
  TabMenuVerticalArrowIcon as ArrowIcon,
  TabMenuVerticalContent as Content,
};
