"use client";

// Inspect-only native subagent rows nested under a parent thread row in the
// sidebar. Each row projects one ENGINE-NATIVE child execution (execution graph
// mode='native_child'): it is NOT a thread and never messageable - selecting a
// row navigates to the PARENT session with the exact execution and owning run,
// which opens the existing agent detail surface for that child. Durable gateway child
// sessions are real runs and keep their normal thread rows elsewhere.

import type { ApiNativeChildSummary, NativeChildSummaryStatus } from "@useagent/agent-client/wire";
import Link from "next/link";
import { StatusDot } from "@/components/shared/status-dot";
import { cx } from "@/utils/cx";

export type NativeAgentRowState = "running" | "done" | "failed";

export interface NativeAgentRow {
  /** Stable execution id (React key; not navigable on its own). */
  id: string;
  label: string;
  state: NativeAgentRowState;
  /** Parent session deep link carrying the exact execution and owning run. */
  href: string;
}

/** Collapse the execution-graph status enum onto the three sidebar states. */
export function nativeAgentRowState(status: NativeChildSummaryStatus): NativeAgentRowState {
  if (status === "queued" || status === "running" || status === "waiting") return "running";
  if (status === "failed" || status === "cancelled") return "failed";
  return "done";
}

const STATE_PRESENTATION: Record<
  NativeAgentRowState,
  { label: string; dot: { tone: "success" | "error" | "neutral"; pulse?: boolean } }
> = {
  running: { label: "Running", dot: { tone: "success", pulse: true } },
  failed: { label: "Failed", dot: { tone: "error" } },
  done: { label: "Done", dot: { tone: "neutral" } },
};

/** Fold a thread summary's bounded native-children projection into view rows.
 *  Null when the thread has none, so callers can skip the nested list. */
export function sidebarNativeAgentRows(run: {
  readonly id: string;
  readonly native_children?: readonly ApiNativeChildSummary[];
  readonly native_children_total?: number;
}): { rows: NativeAgentRow[]; overflow: number } | null {
  const children = run.native_children ?? [];
  if (children.length === 0) return null;
  const rows = children.map((child) => ({
    id: child.execution_id,
    label: child.title || "Subagent",
    state: nativeAgentRowState(child.status),
    href: `/session/${run.id}?agent_execution=${encodeURIComponent(child.execution_id)}&agent_run=${encodeURIComponent(child.run_id)}`,
  }));
  const total = run.native_children_total ?? children.length;
  return { rows, overflow: Math.max(0, total - rows.length) };
}

/** The nested rows themselves: one more indent step past the thread row, the
 *  shared status dot, and a muted "+N more" line when the server-side bound
 *  truncated the projection. */
export function NativeAgentRows({
  rows,
  overflow,
  tabIndex,
}: {
  rows: readonly NativeAgentRow[];
  overflow: number;
  tabIndex?: number;
}) {
  return (
    <ul aria-label="Subagents" className="flex w-full flex-col">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={row.href}
            tabIndex={tabIndex}
            data-session-ui="native-agent-row"
            title={row.label}
            className="flex h-8 w-full items-center gap-2 rounded-2lg pr-2 pl-10 transition-colors duration-150 ease hover:bg-background-secondary-hover"
          >
            <span className="flex w-4 shrink-0 items-center justify-center">
              <span
                role="img"
                aria-label={STATE_PRESENTATION[row.state].label}
                title={STATE_PRESENTATION[row.state].label}
              >
                <StatusDot {...STATE_PRESENTATION[row.state].dot} />
              </span>
            </span>
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-caption-1-medium",
                row.state === "running" ? "text-text-secondary" : "text-text-tertiary",
              )}
            >
              {row.label}
            </span>
          </Link>
        </li>
      ))}
      {overflow > 0 ? (
        <li className="flex h-6 items-center pl-10 text-caption-1-regular text-text-tertiary">
          +{overflow} more
        </li>
      ) : null}
    </ul>
  );
}
