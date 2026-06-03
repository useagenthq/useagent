"use client";

// The shadcn-style Button that prompt-kit's PromptSuggestion depends on
// (registryDependencies: ["button"]). Vendored here so the prompt-kit set is
// self-contained; `buttonVariants` map shadcn tokens onto our semantic tokens.

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cx } from "@/utils/cx";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-body-2-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-500/10 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent-500 text-white hover:bg-accent-600",
        outline:
          "border border-border-button-default bg-background-primary-default text-text-primary hover:bg-background-secondary-default",
        ghost: "text-text-primary hover:bg-background-secondary-default",
        secondary: "bg-background-secondary-default text-text-primary hover:bg-background-tertiary-default",
        link: "text-accent-500 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-caption-1-medium",
        lg: "h-10 rounded-lg px-5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cx(buttonVariants({ variant, size, className }))} {...props} />
  );
}
