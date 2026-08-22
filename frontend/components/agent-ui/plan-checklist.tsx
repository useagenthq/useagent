"use client";

import {
  RiArrowDownSLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleFill,
  RiIndeterminateCircleLine,
  RiLoader4Line,
  type RemixiconComponentType,
} from "@remixicon/react";
import { useState } from "react";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import { cx } from "@/utils/cx";

export type PlanEntry = NonNullable<CanonicalEventLike["entries"]>[number];
export type PlanEntryStatus = PlanEntry["status"];

export interface PlanChecklistProps {
  readonly title: string;
  readonly entries: readonly PlanEntry[];
  readonly className?: string;
  /** DOM marker for e2e probes (the live timeline sets `"todo-list"`). */
  readonly testId?: string;
  /** Card starts expanded; pass `false` to collapse a settled plan. */
  readonly defaultOpen?: boolean;
}

const STATUS_LABEL: Record<PlanEntryStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ITEM_ICON: Record<PlanEntryStatus, RemixiconComponentType> = {
  pending: RiCheckboxBlankCircleLine,
  in_progress: RiLoader4Line,
  completed: RiCheckboxCircleFill,
  cancelled: RiIndeterminateCircleLine,
};

const ITEM_TONE: Record<PlanEntryStatus, string> = {
  pending: "text-text-tertiary",
  in_progress: "text-accent-500",
  completed: "text-lime-600",
  cancelled: "text-text-disabled",
};

/**
 * The green completion mark that morphs by state: a solid check once every entry
 * is done, otherwise a progress ring filled to the completed ratio. Purely
 * decorative — the header's visible `done/total` count carries the semantics.
 */
function CompletionMark({ done, total }: { readonly done: number; readonly total: number }) {
  if (total > 0 && done === total) {
    return (
      <RiCheckboxCircleFill
        className="size-5 shrink-0 text-lime-600 transition-colors duration-300"
        aria-hidden
      />
    );
  }
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const ratio = total === 0 ? 0 : done / total;
  return (
    <svg viewBox="0 0 18 18" className="size-5 shrink-0" aria-hidden>
      <circle cx="9" cy="9" r={radius} strokeWidth="2" className="fill-none stroke-background-tertiary-default" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        strokeWidth="2"
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        className="fill-none stroke-lime-500 transition-[stroke-dashoffset] duration-500 ease-out"
      />
    </svg>
  );
}

/**
 * A collapsible plan card in the beUI Todo List grammar: a header that morphs a
 * green completion mark, shows the plan title and a `done/total` count in success
 * tone, and toggles the item list; items are circled by state, completed and
 * cancelled entries strike through in a muted tone, and the active entry is
 * highlighted. State changes ease via motion-safe CSS transitions so a live plan
 * update reads as a smooth in-place change rather than a jump.
 */
export function PlanChecklist({
  title,
  entries,
  className,
  testId,
  defaultOpen = true,
}: PlanChecklistProps) {
  const [open, setOpen] = useState(defaultOpen);
  const total = entries.length;
  const done = entries.filter((entry) => entry.status === "completed").length;

  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={cx(
        "overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <CompletionMark done={done} total={total} />
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">{title}</span>
        <span
          className="text-caption-1-medium font-medium tabular-nums text-lime-600"
          aria-label={`${done} of ${total} complete`}
        >
          {done}/{total}
        </span>
        <RiArrowDownSLine
          className={cx(
            "size-4 shrink-0 text-text-tertiary transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="border-t border-border-button-default py-1 motion-safe:animate-ai-fade-up">
          {entries.map((entry) => {
            const Icon = ITEM_ICON[entry.status];
            const struck = entry.status === "completed" || entry.status === "cancelled";
            const active = entry.status === "in_progress";
            return (
              <li
                key={entry.id}
                className={cx(
                  "flex items-start gap-2.5 px-4 py-2 transition-colors duration-300",
                  active && "bg-accent-500/10",
                )}
              >
                <Icon
                  className={cx(
                    "mt-0.5 size-4 shrink-0 transition-colors duration-300",
                    ITEM_TONE[entry.status],
                    active && "motion-safe:animate-spin",
                  )}
                  aria-hidden
                />
                <span
                  className={cx(
                    "min-w-0 flex-1 text-body-2-regular transition-colors duration-300",
                    struck && "text-text-tertiary line-through",
                    active && "font-medium text-text-primary",
                    !struck && !active && "text-text-secondary",
                  )}
                >
                  {entry.text}
                </span>
                <span className="sr-only">{STATUS_LABEL[entry.status]}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
