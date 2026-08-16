import {
  RiCheckboxCircleFill,
  RiCloseCircleLine,
  RiLoader4Line,
  RiTimeLine,
} from "@remixicon/react";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";

export type PlanEntry = NonNullable<CanonicalEventLike["entries"]>[number];

export interface PlanChecklistProps {
  readonly title: string;
  readonly entries: readonly PlanEntry[];
  readonly className?: string;
}

const STATUS_LABEL: Record<PlanEntry["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function EntryIcon({ status }: { readonly status: PlanEntry["status"] }) {
  switch (status) {
    case "completed":
      return <RiCheckboxCircleFill className="size-4 text-success-base" aria-hidden />;
    case "in_progress":
      return <RiLoader4Line className="size-4 animate-spin text-information-base" aria-hidden />;
    case "cancelled":
      return <RiCloseCircleLine className="size-4 text-text-soft-400" aria-hidden />;
    case "pending":
      return <RiTimeLine className="size-4 text-text-soft-400" aria-hidden />;
    default:
      status satisfies never;
      return null;
  }
}

export function PlanChecklist({ title, entries, className }: PlanChecklistProps) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const progress = entries.length === 0 ? 0 : Math.round((completed / entries.length) * 100);

  return (
    <section
      aria-label={title}
      className={`overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs ${className ?? ""}`}
    >
      <div className="border-b border-stroke-soft-200 bg-bg-weak-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-label-sm text-text-strong-950">{title}</h3>
          <span className="font-mono text-label-xs text-text-soft-400">
            {completed}/{entries.length}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`${title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="mt-2 h-1 overflow-hidden rounded-full bg-bg-soft-200"
        >
          <div
            className="h-full rounded-full bg-primary-base transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <ol className="divide-y divide-stroke-soft-200">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-start gap-2.5 px-4 py-2.5">
            <EntryIcon status={entry.status} />
            <span
              className={`min-w-0 flex-1 text-paragraph-sm ${
                entry.status === "cancelled"
                  ? "text-text-soft-400 line-through"
                  : "text-text-sub-600"
              }`}
            >
              {entry.text}
            </span>
            <span className="sr-only">{STATUS_LABEL[entry.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
