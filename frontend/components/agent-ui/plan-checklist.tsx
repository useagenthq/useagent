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
import { cnExt as cn } from "@/utils/cn";

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
  pending: "text-text-soft-400",
  in_progress: "text-primary-base",
  completed: "text-success-base",
  cancelled: "text-text-disabled-300",
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
        className="size-5 shrink-0 text-success-base transition-colors duration-300"
        aria-hidden
      />
    );
  }
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const ratio = total === 0 ? 0 : done / total;
  return (
    <svg viewBox="0 0 18 18" className="size-5 shrink-0" aria-hidden>
      <circle cx="9" cy="9" r={radius} strokeWidth="2" className="fill-none stroke-bg-soft-200" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        strokeWidth="2"
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        className="fill-none stroke-success-base transition-[stroke-dashoffset] duration-500 ease-out"
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
      className={cn(
        "overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-bg-weak-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
      >
        <CompletionMark done={done} total={total} />
        <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">{title}</span>
        <span
          className="text-label-xs font-medium tabular-nums text-success-base"
          aria-label={`${done} of ${total} complete`}
        >
          {done}/{total}
        </span>
        <RiArrowDownSLine
          className={cn(
            "size-4 shrink-0 text-text-soft-400 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="border-t border-stroke-soft-200 py-1 motion-safe:animate-ai-fade-up">
          {entries.map((entry) => {
            const Icon = ITEM_ICON[entry.status];
            const struck = entry.status === "completed" || entry.status === "cancelled";
            const active = entry.status === "in_progress";
            return (
              <li
                key={entry.id}
                className={cn(
                  "flex items-start gap-2.5 px-4 py-2 transition-colors duration-300",
                  active && "bg-primary-alpha-10",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0 transition-colors duration-300",
                    ITEM_TONE[entry.status],
                    active && "motion-safe:animate-spin",
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-paragraph-sm transition-colors duration-300",
                    struck && "text-text-soft-400 line-through",
                    active && "font-medium text-text-strong-950",
                    !struck && !active && "text-text-sub-600",
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
