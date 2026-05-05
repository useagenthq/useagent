import type { ComponentType, ReactNode } from "react";
import { RiFileList2Line } from "@remixicon/react";
import * as Badge from "@/components/ui/badge";
import { cnExt as cn } from "@/utils/cn";

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
      className={cn(
        "overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs transition-colors hover:border-stroke-sub-300",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-stroke-soft-200 px-3 py-2">
        <Icon
          className="size-3.5 shrink-0 text-text-soft-400"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">
          {title}
        </span>
        {meta && (
          <span className="shrink-0 text-paragraph-xs tabular-nums text-text-soft-400">
            {meta}
          </span>
        )}
      </div>
      <div className="line-clamp-2 px-3 py-2 text-paragraph-sm text-text-sub-600">
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
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-label-sm text-text-strong-950">{label}</span>
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
