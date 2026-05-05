// AlignUI TabMenuHorizontal v0.0.0

'use client';

import * as React from 'react';
import { Slottable } from '@radix-ui/react-slot';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import mergeRefs from 'merge-refs';

import { cn, cnExt } from '@/utils/cn';
import type { PolymorphicComponentProps } from '@/utils/polymorphic';
import { useTabObserver } from '@/hooks/use-tab-observer';

const TabMenuHorizontalContent = TabsPrimitive.Content;
TabMenuHorizontalContent.displayName = 'TabMenuHorizontalContent';

const TabMenuHorizontalRoot = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  Omit<React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>, 'orientation'>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <TabsPrimitive.Root
      ref={forwardedRef}
      orientation='horizontal'
      className={cnExt('w-full', className)}
      {...rest}
    />
  );
});
TabMenuHorizontalRoot.displayName = 'TabMenuHorizontalRoot';

const TabMenuHorizontalList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    wrapperClassName?: string;
  }
>(({ children, className, wrapperClassName, ...rest }, forwardedRef) => {
  const [lineStyle, setLineStyle] = React.useState({ width: 0, left: 0 });
  const listWrapperRef = React.useRef<HTMLDivElement>(null);

  const { mounted, listRef } = useTabObserver({
    onActiveTabChange: (_, activeTab) => {
      const { offsetWidth: width, offsetLeft: left } = activeTab;
      setLineStyle({ width, left });

      const listWrapper = listWrapperRef.current;
      if (listWrapper) {
        const containerWidth = listWrapper.clientWidth;
        const scrollPosition = left - containerWidth / 2 + width / 2;

        listWrapper.scrollTo({
          left: scrollPosition,
          behavior: 'smooth',
        });
      }
    },
  });

  return (
    <div
      ref={listWrapperRef}
      className={cn(
        'relative grid overflow-x-auto overflow-y-hidden overscroll-contain',
        wrapperClassName,
      )}
    >
      <TabsPrimitive.List
        ref={mergeRefs(forwardedRef, listRef)}
        className={cnExt(
          'group/tab-list relative flex h-12 items-center gap-6 whitespace-nowrap border-y border-stroke-soft-200',
          className,
        )}
        {...rest}
      >
        <Slottable>{children}</Slottable>

        {/* Floating Bg */}
        <div
          className={cn(
            'absolute -bottom-px left-0 h-0.5 bg-primary-base opacity-0 transition-all duration-300 group-has-[[data-state=active]]/tab-list:opacity-100',
            {
              hidden: !mounted,
            },
          )}
          style={{
            transform: `translate3d(${lineStyle.left}px, 0, 0)`,
            width: `${lineStyle.width}px`,
            transitionTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
          }}
          aria-hidden='true'
        />
      </TabsPrimitive.List>
    </div>
  );
});
TabMenuHorizontalList.displayName = 'TabMenuHorizontalList';

const TabMenuHorizontalTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <TabsPrimitive.Trigger
      ref={forwardedRef}
      className={cnExt(
        // base
        'group/tab-item h-12 py-3.5 text-label-sm text-text-sub-600 outline-none',
        'flex items-center justify-center gap-1.5',
        'transition duration-200 ease-out',
        // focus
        'focus:outline-none',
        // active
        'data-[state=active]:text-text-strong-950',
        className,
      )}
      {...rest}
    />
  );
});
TabMenuHorizontalTrigger.displayName = 'TabMenuHorizontalTrigger';

function TabMenuHorizontalIcon<T extends React.ElementType>({
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
TabMenuHorizontalIcon.displayName = 'TabsHorizontalIcon';

function TabMenuHorizontalArrowIcon<T extends React.ElementType>({
  className,
  as,
  ...rest
}: PolymorphicComponentProps<T, React.HTMLAttributes<HTMLDivElement>>) {
  const Component = as || 'div';

  return (
    <Component
      className={cnExt('size-5 text-text-sub-600', className)}
      {...rest}
    />
  );
}
TabMenuHorizontalArrowIcon.displayName = 'TabsHorizontalArrow';

export {
  TabMenuHorizontalRoot as Root,
  TabMenuHorizontalList as List,
  TabMenuHorizontalTrigger as Trigger,
  TabMenuHorizontalIcon as Icon,
  TabMenuHorizontalArrowIcon as ArrowIcon,
  TabMenuHorizontalContent as Content,
};
