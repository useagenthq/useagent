import type { ComponentType, ReactNode } from "react";
import { RiFileList2Line } from "@remixicon/react";
import * as Badge from "@/components/ui/badge";
import { cx } from "@/utils/cx";

/**
 * Retrieved-context primitive — the "All chunks · 32" pattern from the AI
 * component library, ported onto AlignUI semantic tokens.
 *
 * `ContextCard` is one retrieved chunk: a title bar (glyph + name + a
 * right-aligned caption for char-count / citation) over a two-line body
 * preview. `ContextCardStack` stacks several under a labelled header with a
 * count pill.
 *
 * Presentational only (no hooks) — safe to compose inside any client surface.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface ContextCardProps {
  title: string;
  body: ReactNode;
  /** Right-aligned title-bar caption — char count, citation, source line… */
  meta?: string;
  /** Leading glyph; defaults to a document-lines mark. */
  icon?: IconComponent;
  className?: string;
}

export function ContextCard({
  title,
  body,
  meta,
  icon: Icon = RiFileList2Line,
  className,
}: ContextCardProps) {
  return (
    <article
      className={cx(
        "overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default shadow-card transition-colors hover:border-border-button-hover",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border-button-default px-3 py-2">
        <Icon
          className="size-3.5 shrink-0 text-text-tertiary"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
          {title}
        </span>
        {meta && (
          <span className="shrink-0 text-caption-1-regular tabular-nums text-text-tertiary">
            {meta}
          </span>
        )}
      </div>
      <div className="line-clamp-2 px-3 py-2 text-body-2-regular text-text-secondary">
        {body}
      </div>
    </article>
  );
}

export interface ContextCardStackProps {
  label: string;
  count: number;
  cards: ContextCardProps[];
  className?: string;
}

export function ContextCardStack({
  label,
  count,
  cards,
  className,
}: ContextCardStackProps) {
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-body-2-medium text-text-primary">{label}</span>
        <Badge.Root variant="light" color="gray" size="medium">
          {count}
        </Badge.Root>
      </div>
      {cards.map((card, i) => (
        <ContextCard key={`${card.title}-${i}`} {...card} />
      ))}
    </div>
  );
}
