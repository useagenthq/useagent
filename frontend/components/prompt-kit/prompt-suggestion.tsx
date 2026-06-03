"use client";

// Vendored from prompt-kit (prompt-kit.com/c/prompt-suggestion.json). Adapted:
// `cn` → `cnExt`; shadcn tokens (`hover:bg-accent`, `text-muted-foreground`,
// `text-primary`) → ours; Button/buttonVariants sourced from the co-located
// vendored ./button. Two modes: a rounded-full chip (no highlight) and a
// left-aligned list row with substring highlighting (for command/mention menus).

import { type VariantProps } from "class-variance-authority";
import { cx } from "@/utils/cx";
import { Button, buttonVariants } from "./button";

export type PromptSuggestionProps = {
  children: React.ReactNode;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  highlight?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

function PromptSuggestion({
  children,
  variant,
  size,
  className,
  highlight,
  ...props
}: PromptSuggestionProps) {
  const isHighlightMode = highlight !== undefined && highlight.trim() !== "";
  const content = typeof children === "string" ? children : "";

  if (!isHighlightMode) {
    return (
      <Button
        variant={variant || "outline"}
        size={size || "lg"}
        className={cx("rounded-full", className)}
        {...props}
      >
        {children}
      </Button>
    );
  }

  if (!content) {
    return (
      <Button
        variant={variant || "ghost"}
        size={size || "sm"}
        className={cx(
          "w-full cursor-pointer justify-start rounded-xl py-2",
          "hover:bg-background-secondary-default",
          className,
        )}
        {...props}
      >
        {children}
      </Button>
    );
  }

  const trimmedHighlight = highlight.trim();
  const contentLower = content.toLowerCase();
  const highlightLower = trimmedHighlight.toLowerCase();
  const shouldHighlight = contentLower.includes(highlightLower);

  return (
    <Button
      variant={variant || "ghost"}
      size={size || "sm"}
      className={cx(
        "w-full cursor-pointer justify-start gap-0 rounded-xl py-2",
        "hover:bg-background-secondary-default",
        className,
      )}
      {...props}
    >
      {shouldHighlight ? (
        (() => {
          const index = contentLower.indexOf(highlightLower);
          if (index === -1)
            return (
              <span className="text-text-tertiary whitespace-pre-wrap">
                {content}
              </span>
            );

          const actualHighlightedText = content.substring(
            index,
            index + highlightLower.length,
          );
          const before = content.substring(0, index);
          const after = content.substring(index + actualHighlightedText.length);

          return (
            <>
              {before && (
                <span className="text-text-tertiary whitespace-pre-wrap">
                  {before}
                </span>
              )}
              <span className="text-text-primary font-medium whitespace-pre-wrap">
                {actualHighlightedText}
              </span>
              {after && (
                <span className="text-text-tertiary whitespace-pre-wrap">
                  {after}
                </span>
              )}
            </>
          );
        })()
      ) : (
        <span className="text-text-tertiary whitespace-pre-wrap">{content}</span>
      )}
    </Button>
  );
}

export { PromptSuggestion };
