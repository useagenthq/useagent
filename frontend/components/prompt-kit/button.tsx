"use client";

// The shadcn-style Button that prompt-kit's PromptSuggestion depends on
// (registryDependencies: ["button"]). Vendored here so the prompt-kit set is
// self-contained; `buttonVariants` are mapped from shadcn tokens onto AlignUI
// semantic tokens. The AlignUI foundation ships its own richer Button
// (components/ui/button) for app chrome — this one exists only to satisfy the
// vendored prompt-kit primitives.

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cnExt as cn } from "@/utils/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-label-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary-alpha-10 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary-base text-static-white hover:bg-primary-dark",
        outline:
          "border border-stroke-soft-200 bg-bg-white-0 text-text-strong-950 hover:bg-bg-weak-50",
        ghost: "text-text-strong-950 hover:bg-bg-weak-50",
        secondary: "bg-bg-weak-50 text-text-strong-950 hover:bg-bg-soft-200",
        link: "text-primary-base underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-label-xs",
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
    <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}
