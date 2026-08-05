// AlignUI SocialButton v0.0.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { PolymorphicComponentProps } from '@/utils/polymorphic';
import { recursiveCloneChildren } from '@/utils/recursive-clone-children';
import { tv, type VariantProps } from '@/utils/tv';

const SOCIAL_BUTTON_ROOT_NAME = 'SocialButtonRoot';
const SOCIAL_BUTTON_ICON_NAME = 'SocialButtonIcon';

export const socialButtonVariants = tv({
  slots: {
    root: [
      // base
      'relative inline-flex h-10 items-center justify-center gap-3.5 whitespace-nowrap rounded-10 px-4 text-label-sm outline-none',
      'transition duration-200 ease-out',
      // focus
      'focus:outline-none',
    ],
    icon: 'relative z-10 -mx-1.5 size-5 shrink-0',
  },
  variants: {
    brand: {
      apple: {},
      twitter: {},
      google: {},
      facebook: {},
      linkedin: {},
      github: {},
      dropbox: {},
    },
    mode: {
      filled: {
        root: [
          // base
          'text-static-white',
          // before
          'before:pointer-events-none before:absolute before:inset-0 before:rounded-10 before:opacity-0 before:transition before:duration-200 before:ease-out',
          // hover
          'hover:before:opacity-100',
          // focus
          'focus-visible:shadow-button-important-focus',
        ],
      },
      stroke: {
        root: [
          // base
          'bg-bg-white-0 text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200',
          // hover
          'hover:bg-bg-weak-50 hover:shadow-none hover:ring-transparent',
          // focus
          'focus-visible:shadow-button-important-focus focus-visible:ring-stroke-strong-950',
        ],
      },
    },
  },
  compoundVariants: [
    //#region mode=filled
    {
      brand: 'apple',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-static-black',
          // before
          'before:bg-white-alpha-16',
        ],
      },
    },
    {
      brand: 'twitter',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-static-black',
          // before
          'before:bg-white-alpha-16',
        ],
      },
    },
    {
      brand: 'google',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-[#f14336]',
          // before
          'before:bg-static-black/[.16]',
        ],
      },
    },
    {
      brand: 'facebook',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-[#1977f3]',
          // before
          'before:bg-static-black/[.16]',
        ],
      },
    },
    {
      brand: 'linkedin',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-[#0077b5]',
          // before
          'before:bg-static-black/[.16]',
        ],
      },
    },
    {
      brand: 'github',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-[#24292f]',
          // before
          'before:bg-white-alpha-16',
        ],
      },
    },
    {
      brand: 'dropbox',
      mode: 'filled',
      class: {
        root: [
          // base
          'bg-[#3984ff]',
          // before
          'before:bg-static-black/[.16]',
        ],
      },
    },
    //#endregion

    //#region mode=stroke
    {
      brand: 'apple',
      mode: 'stroke',
      class: {
        root: [
          // base
          'text-social-apple',
        ],
      },
    },
    {
      brand: 'twitter',
      mode: 'stroke',
      class: {
        root: [
          // base
          'text-social-twitter',
        ],
      },
    },
    {
      brand: 'github',
      mode: 'stroke',
      class: {
        root: [
          // base
          'text-social-github',
        ],
      },
    },
    //#endregion
  ],
  defaultVariants: {
    mode: 'filled',
  },
});

type SocialButtonSharedProps = VariantProps<typeof socialButtonVariants>;

type SocialButtonProps = VariantProps<typeof socialButtonVariants> &
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  };

const SocialButtonRoot = React.forwardRef<HTMLButtonElement, SocialButtonProps>(
  ({ asChild, children, mode, brand, className, ...rest }, forwardedRef) => {
    const uniqueId = React.useId();
    const Component = asChild ? Slot : 'button';
    const { root } = socialButtonVariants({ brand, mode });

    const sharedProps: SocialButtonSharedProps = {
      mode,
      brand,
    };

    const extendedChildren = recursiveCloneChildren(
      children as React.ReactElement[],
      sharedProps,
      [SOCIAL_BUTTON_ICON_NAME],
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
  },
);
SocialButtonRoot.displayName = SOCIAL_BUTTON_ROOT_NAME;

function SocialButtonIcon<T extends React.ElementType>({
  brand,
  mode,
  className,
  as,
  ...rest
}: PolymorphicComponentProps<T, SocialButtonSharedProps>) {
  const Component = as || 'div';
  const { icon } = socialButtonVariants({ brand, mode });

  return <Component className={icon({ class: className })} {...rest} />;
}
SocialButtonIcon.displayName = SOCIAL_BUTTON_ICON_NAME;

export { SocialButtonRoot as Root, SocialButtonIcon as Icon };
