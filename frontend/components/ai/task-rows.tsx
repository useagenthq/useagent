"use client";

import { useState } from "react";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import { cx } from "@/utils/cx";

/**
 * Agent task list — a stack of expandable task cards. Each row shows a status
 * glyph (done check / running spinner / pending ring), a title, an optional
 * count, an optional status pill, and — when it carries substeps — a collapsible
 * detail region down a hairline connector. Ported from the beautiful-ui TaskRows
 * demo (hardcoded → parameterized) onto AlignUI tokens.
 */

export type TaskRowStatus = "done" | "running" | "pending";

export interface TaskSubstep {
  label: string;
  value: string;
}

export interface TaskRowItem {
  title: string;
  status: TaskRowStatus;
  /** Right-aligned count caption ("12 suppliers"). */
  count?: string;
  /** Optional status pill (usually paired with a done row). */
  statusLabel?: string;
  /** Number rendered inside the running / pending ring. */
  index?: number;
  substeps?: TaskSubstep[];
}

export interface TaskRowsProps {
  tasks: TaskRowItem[];
  className?: string;
}

const pill: Record<TaskRowStatus, string> = {
  done: "bg-status-lime-background text-status-lime-text",
  running: "bg-status-blue-background text-status-blue-text",
  pending: "bg-background-secondary-default text-text-secondary",
};

function StatusGlyph({
  status,
  index,
}: {
  status: TaskRowStatus;
  index?: number;
}) {
  if (status === "done") {
    return (
      <span className="animate-ai-fade-up bg-lime-500 text-text-white flex size-5 items-center justify-center rounded-full">
        <RiCheckLine className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className="relative inline-flex size-6 items-center justify-center"
      aria-hidden
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: this progress ring is decorative and hidden by its parent */}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        className={cx("absolute inset-0", status === "running" && "animate-spin")}
      >
        <circle
          cx="12"
          cy="12"
          r="11"
          fill="none"
          stroke="var(--color-border-button-default)"
          strokeWidth="2"
        />
        {status === "running" && (
          <circle
            cx="12"
            cy="12"
            r="11"
            fill="none"
            stroke="var(--color-text-secondary)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="19 50"
          />
        )}
      </svg>
      {typeof index === "number" && (
        <span className="text-text-primary relative text-[10.5px] font-semibold tabular-nums">
          {index}
        </span>
      )}
    </span>
  );
}

function TaskCard({ task, delay }: { task: TaskRowItem; delay: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasSteps = Boolean(task.substeps?.length);

  return (
    <div
      className="animate-ai-fade-up border-border-button-default bg-background-primary-default shadow-sm overflow-hidden rounded-2xl border"
      style={{ animationDelay: `${delay}ms` }}
    >
      <button
        type="button"
        aria-expanded={hasSteps ? expanded : undefined}
        disabled={!hasSteps}
        onClick={() => hasSteps && setExpanded((e) => !e)}
        className={cx(
          "flex h-11 w-full items-center gap-2.5 px-2.5 text-left transition-colors duration-100",
          hasSteps ? "hover:bg-background-primary-hover" : "cursor-default",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          <StatusGlyph status={task.status} index={task.index} />
        </span>
        <span className="text-body-2-medium text-text-primary min-w-0 flex-1 truncate">
          {task.title}
        </span>
        {task.count && (
          <span className="text-caption-1-regular text-text-secondary shrink-0 tabular-nums">
            {task.count}
          </span>
        )}
        {task.statusLabel && (
          <span
            className={cx(
              "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption-1-medium",
              pill[task.status],
            )}
          >
            {task.statusLabel}
          </span>
        )}
        {hasSteps && (
          <RiArrowDownSLine
            className={cx(
              "text-text-tertiary size-4 shrink-0 transition-transform duration-300",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </button>

      {hasSteps && (
        <div
          className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
          style={{
            gridTemplateRows: expanded ? "1fr" : "0fr",
            opacity: expanded ? 1 : 0,
          }}
        >
          <div className="overflow-hidden">
            <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
              <span aria-hidden className="bg-border-button-default mx-auto h-full w-px" />
              <div className="flex flex-col gap-1.5">
                {task.substeps!.map((step) => (
                  <div
                    key={step.label}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-caption-1-regular text-text-secondary min-w-0 truncate">
                      {step.label}
                    </span>
                    <span className="text-text-tertiary shrink-0 font-mono text-[11.5px] tabular-nums">
                      {step.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function TaskRows({ tasks, className }: TaskRowsProps) {
  return (
    <div className={cx("flex w-full flex-col gap-2", className)}>
      {tasks.map((task, i) => (
        <TaskCard key={`${task.title}-${i}`} task={task} delay={i * 80} />
      ))}
    </div>
  );
}
