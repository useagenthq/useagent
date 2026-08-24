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
// - lucide-react -> @remixicon/react; shadcn tokens -> our semantic tokens.
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

import { RiArrowRightSLine, RiCheckLine, RiErrorWarningLine } from "@remixicon/react";
import Link from "next/link";
import type { ChildUsage } from "@/components/chat/child-usage";
import type { ChildStatus } from "@/components/chat/native-events";
import { type EngineId, engineLabel } from "@/components/chat/types";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import { cx as cn } from "@/utils/cx";

/** Everything the row renders, already resolved against OUR child model. */
export interface AgentPanelRowModel {
  readonly title: string;
  readonly role: string | null;
  /** Engine that runs this child (gateway children); null for native children
   *  whose engine is the parent's. Rendered in the meta caption. */
  readonly engine: EngineId | null;
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

export function formatSubagentCostUsd(costUsd: number): string {
  return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

/** Settled/terminal glyph for the right meta cluster: a check when completed, a
 *  warning when it ended badly, nothing while live (the pulsing dot carries it). */
function AgentStateGlyph({ status }: { status: ChildStatus }) {
  if (status === "completed") {
    return <RiCheckLine aria-hidden className="text-lime-600 size-3.5 shrink-0" />;
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <RiErrorWarningLine aria-hidden className="text-red-500 size-3.5 shrink-0" />;
  }
  return null;
}

/**
 * One subagent row in the compact rail grammar: a single baseline line - status
 * dot + title (truncated) left, a right-aligned meta cluster (engine/model +
 * token caption, terminal glyph, elapsed, chevron) all vertically centered - plus
 * an OPTIONAL second caption line that appears only when real activity/result
 * text exists. No fixed multi-row grid, so a card with nothing to say stays a
 * single tidy line instead of a tall block of dead space.
 *
 * Renders as a `<Link>` when `href` is given (gateway children open their own
 * session) or a `<button>` when `onOpen` is given (native children open the
 * in-rail detail). BoardUI tokens, plain glyphs, no motion wrappers.
 */
export function AgentPanelRow({
  agent,
  onOpen,
  href,
}: {
  agent: AgentPanelRowModel;
  onOpen?: () => void;
  href?: string;
}) {
  const live = isActiveStatus(agent.status);
  // Second line only when there is real content: the activity/result text, else
  // the status word - EXCEPT a completed row, whose check glyph already says it
  // (so a settled card with nothing to add stays a single tidy line).
  const caption =
    agentPanelActivityText(agent) ?? (agent.status === "completed" ? null : agent.statusLabel);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const meta = [
    agent.engine ? engineLabel(agent.engine) : null,
    formatSubagentModelLabel(agent.model, null),
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.costUsd !== undefined ? formatSubagentCostUsd(agent.usage.costUsd) : null,
  ].filter((value): value is string => value !== null);

  const className =
    "bg-background-secondary-default border-border-button-default hover:bg-background-tertiary-hover block w-full rounded-xl border px-3 py-2 text-left transition-colors";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <StatusDot tone={STATUS_TONE[agent.status]} pulse={live} />
        <span className="text-body-2-medium text-text-primary min-w-0 flex-1 truncate">
          {agent.title}
        </span>
        {role ? (
          <span className="border-border-button-default text-text-tertiary max-w-24 shrink-0 truncate rounded-sm border px-1 font-mono text-[.65rem]">
            {role}
          </span>
        ) : null}
        {meta.length > 0 ? (
          <span className="text-text-tertiary shrink-0 truncate font-mono text-caption-1-medium tabular-nums">
            {meta.join(" · ")}
          </span>
        ) : null}
        {agent.elapsed ? (
          <span className="text-text-tertiary shrink-0 font-mono text-caption-1-medium tabular-nums">
            {agent.elapsed}
          </span>
        ) : null}
        <AgentStateGlyph status={agent.status} />
        <RiArrowRightSLine className="text-text-tertiary size-4 shrink-0" aria-hidden />
      </div>
      {caption ? (
        <p
          className={cn(
            "mt-0.5 truncate pl-[1.25rem] text-caption-1-regular",
            agent.status === "failed" ? "text-text-error-primary" : "text-text-secondary",
            live && "agent-progress-loading-text",
          )}
        >
          {caption}
        </p>
      ) : null}
      <span className="sr-only">{agent.statusLabel}</span>
    </>
  );

  return href ? (
    <Link
      href={href}
      data-testid="subagent-card"
      data-session-ui="agent-panel-row"
      aria-label={`Open subagent: ${agent.title}`}
      className={className}
    >
      {body}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onOpen}
      data-testid="subagent-card"
      data-session-ui="agent-panel-row"
      aria-label={`Open subagent: ${agent.title}`}
      className={className}
    >
      {body}
    </button>
  );
}
