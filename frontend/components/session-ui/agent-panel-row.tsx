"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/AgentsPanel.tsx
//   AgentRow + StatusDot + agentActivityText (the fleet row: three fixed lines -
//   status dot + name + role chip + elapsed, then the status-dependent activity
//   line, then the mono metrics line) and
//   packages/client-runtime/src/state/subagentRuntime.ts
//   formatSubagentModelLabel + formatSubagentTokenCount.
//
// Port notes:
// - lucide-react -> @remixicon/react; shadcn tokens -> AlignUI semantic tokens.
// - Bound to OUR child model (SubagentCard + child fidelity), not T3's
//   RuntimeSubagent: no effort/activationCount/outputFile; `result` carries the
//   error text on failed rows (our fidelity folds errors into resultText); our
//   latest native-attributed step label slots into the activity fallback chain.
// - T3's "— tok" placeholder is dropped: token usage renders ONLY when child
//   usage exists (never fabricate).
// - The row is a button (chevron + onOpen) because our rail opens a per-agent
//   detail view; T3's row is non-interactive. data-testid/aria kept from the
//   row this replaces so the rail's inspect behavior is unchanged.
// - Elapsed is precomputed by the caller (the rail's useNow/childElapsedMs +
//   formatDuration) instead of T3's DOM-write AgentElapsed timer.
// - Dot = the shared StatusDot primitive (components/shared/status-dot), pulsing
//   while active, instead of a parallel dot implementation.

import { RiArrowRightSLine, RiCheckLine } from "@remixicon/react";
import type { ChildUsage } from "@/components/chat/child-usage";
import type { ChildStatus } from "@/components/chat/native-events";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import { cx as cn } from "@/utils/cx";

/** Everything the row renders, already resolved against OUR child model. */
export interface AgentPanelRowModel {
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly status: ChildStatus;
  /** Human status word for `status` (sr-only text + activity fallback). */
  readonly statusLabel: string;
  /** Latest bounded native progress summary (streamed text snippet). */
  readonly progress: string | null;
  readonly lastToolName: string | null;
  /** Latest native-attributed step label from the run's step stream. */
  readonly lastStepLabel: string | null;
  /** Returned answer for settled rows; carries the error text when failed. */
  readonly result: string | null;
  readonly usage: ChildUsage | null;
  /** Preformatted elapsed ("34s"); null when no honest wall clock exists. */
  readonly elapsed: string | null;
}

/** In-flight states all present as one steady working state (T3 rule: detail
 *  belongs in the activity sub-line). Only settled states differentiate. */
const isActiveStatus = (status: ChildStatus): boolean =>
  status === "pending" || status === "running" || status === "waiting";

export const STATUS_TONE: Record<ChildStatus, DotTone> = {
  pending: "info",
  running: "info",
  waiting: "info",
  // Idle reads as settled (muted, not info): a resting child looks done unless
  // resumed - upstream live-test: info idle dots read as stuck in-progress.
  idle: "neutral",
  completed: "success",
  failed: "error",
  cancelled: "neutral",
  interrupted: "neutral",
};

/**
 * Status-dependent activity line (upstream agentActivityText). Live rows lead
 * with what is happening now; settled rows lead with the outcome. Failed rows
 * lead with their error (folded into `result`) because it explains a red row
 * at a glance. Null when nothing honest exists - callers fall back to the
 * status label.
 */
export function agentPanelActivityText(agent: AgentPanelRowModel): string | null {
  const toolLine = agent.lastToolName ? `▸ ${agent.lastToolName}` : null;
  if (isActiveStatus(agent.status)) {
    return agent.progress ?? agent.lastStepLabel ?? toolLine ?? agent.result;
  }
  return agent.result ?? agent.progress ?? agent.lastStepLabel ?? toolLine;
}

/**
 * Compact model chip text: strips vendor prefixes/date-or-context suffixes
 * ("claude-sonnet-5[1m]" -> "sonnet-5[1m]", "claude-opus-4-20250514" ->
 * "opus-4"). Unknown ids pass through untouched; effort appends as "· high".
 */
export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) {
    return null;
  }
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}

/**
 * The T3 fleet row bound to our child model: three fixed grid lines (identity,
 * activity, metrics) whose height never changes as data streams in, wrapped in
 * our rail's openable card chrome.
 */
export function AgentPanelRow({
  agent,
  onOpen,
}: {
  agent: AgentPanelRowModel;
  onOpen: () => void;
}) {
  const live = isActiveStatus(agent.status);
  const activity = agentPanelActivityText(agent);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    formatSubagentModelLabel(agent.model, null),
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="subagent-card"
      data-session-ui="agent-panel-row"
      aria-label={`Open subagent: ${agent.title}`}
      className="bg-background-secondary-default border-border-button-default hover:bg-background-tertiary-hover animate-ai-fade-up flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors"
    >
      <div className="grid min-w-0 flex-1 grid-cols-[0.75rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-1.5">
        <span className="col-start-1 row-start-1 flex items-center">
          <StatusDot tone={STATUS_TONE[agent.status]} pulse={live} />
        </span>
        <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
          <span className="text-body-2-medium text-text-primary min-w-0 truncate">{agent.title}</span>
          {role ? (
            <span className="border-border-button-default text-text-tertiary max-w-28 shrink-0 truncate rounded-sm border px-1 font-mono text-[.65rem]">
              {role}
            </span>
          ) : null}
        </span>
        <span className="text-text-tertiary col-start-3 row-start-1 min-w-14 text-right font-mono text-caption-1-medium">
          <span className="inline-flex items-center gap-1">
            {agent.elapsed ? <span className="tabular-nums">{agent.elapsed}</span> : null}
            {agent.status === "completed" ? (
              <RiCheckLine aria-hidden className="text-lime-600 size-3 shrink-0" />
            ) : null}
          </span>
        </span>
        <span
          className={cn(
            "text-caption-1-regular col-start-2 col-end-4 row-start-2 block truncate",
            agent.status === "failed" ? "text-text-error-primary" : "text-text-secondary",
            live && activity && "agent-progress-loading-text",
          )}
        >
          {activity ?? agent.statusLabel}
        </span>
        <span className="text-text-tertiary col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums">
          {metadata.join(" · ")}
        </span>
        <span className="sr-only">{agent.statusLabel}</span>
      </div>
      <RiArrowRightSLine className="text-text-tertiary size-4 shrink-0" aria-hidden />
    </button>
  );
}
