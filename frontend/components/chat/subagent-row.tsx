"use client";

// One native subagent under its parent turn. Folded it is a single line: the
// status dot, its name, its role and how long it ran. Open, it nests the
// child's own tool rows in the parent's trace grammar (with the durations the
// engine reported) behind the same wavy guide, then a Summary card of what it
// returned, clamped to three lines behind More. A child opens while it works
// and folds once it settled; the reader's toggle wins afterwards.

import { RiArrowDownSLine } from "@remixicon/react";
import { useMemo, useState } from "react";
import {
  childElapsedMs,
  childStatusLabel,
  isChildActive,
  useNow,
} from "@/components/chat/agent-status";
import type { MergedChildFidelity } from "@/components/chat/canonical-children";
import type { SubagentCard } from "@/components/chat/subagents";
import { TraceRowView } from "@/components/chat/turn-trace";
import { traceRowsFromWork, turnNodesFromSteps } from "@/components/chat/turn-trace-model";
import { useTurnUiState } from "@/components/chat/turn-ui-state";
import type { ApiStep } from "@/components/chat/types";
import { Markdown } from "@/components/prompt-kit/markdown";
import {
  CHILD_META_CLASS,
  formatChildEngineModel,
  formatSubagentTokenCount,
  STATUS_TONE,
} from "@/components/session-ui/agent-panel-row";
import { StatusDot } from "@/components/shared/status-dot";
import { cx as cn } from "@/utils/cx";
import { formatElapsed } from "@/utils/format";

/** A summary past this many characters (or three lines) folds behind More. */
const SUMMARY_FOLD_CHARS = 240;

/** What the child returned, as a card: three lines, then More. */
function SummaryCard({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  // ponytail: a length heuristic stands in for measuring three rendered lines.
  const long = text.length >= SUMMARY_FOLD_CHARS || text.split("\n").length > 3;
  return (
    <div
      data-testid="subagent-summary"
      className="mt-1.5 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2"
    >
      <p className="text-caption-1-medium text-text-tertiary">Summary</p>
      <Markdown
        className={cn(
          "mt-0.5 text-[12.5px] leading-5 text-text-secondary",
          long && !more && "line-clamp-3",
        )}
      >
        {text}
      </Markdown>
      {long && (
        <button
          type="button"
          onClick={() => setMore((value) => !value)}
          aria-expanded={more}
          className="mt-1 rounded-sm text-caption-1-medium text-text-secondary underline decoration-transparent underline-offset-2 transition-colors hover:text-text-primary hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {more ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

export function SubagentRow({
  card,
  fidelity,
  steps,
  runLive,
  defaultOpen,
}: {
  card: SubagentCard;
  fidelity: MergedChildFidelity | undefined;
  /** The durable steps attributed to this child, in order (the fold's ownerByStep). */
  steps: readonly ApiStep[];
  /** The parent turn's liveness: the status fallback for a child without a frame. */
  runLive: boolean;
  /** Start open regardless of state (the lab shows a settled child opened). */
  defaultOpen?: boolean;
}) {
  const status = fidelity?.status ?? (runLive ? "running" : "completed");
  const active = isChildActive(status);
  const now = useNow(active);
  const elapsed = formatElapsed(
    childElapsedMs(card, now, active, fidelity?.usage?.durationMs ?? null),
  );
  const [toggled, setToggled] = useTurnUiState<boolean | null>(`subagent:${card.id}`, null);
  const open = toggled ?? defaultOpen ?? active;
  // The child's own step payloads open through the same controlled shape as the
  // parent trace's rows (a Collapse/Expand-all sweep is a parent-trace control).
  const [stepExpansion, setStepExpansion] = useTurnUiState<Record<string, boolean>>(
    `subagent-steps:${card.id}`,
    {},
  );
  const rows = useMemo(() => {
    const nodes = turnNodesFromSteps(
      steps,
      active,
      status === "failed" ? "failed" : active ? "running" : "completed",
    );
    return traceRowsFromWork(nodes, active).filter((row) => row.kind === "step");
  }, [steps, active, status]);
  const meta = [
    formatChildEngineModel(null, fidelity?.model),
    fidelity?.usage ? `${formatSubagentTokenCount(fidelity.usage.totalTokens)} tok` : null,
  ].filter((value): value is string => value !== null);
  const statusLabel = childStatusLabel(status, fidelity?.resumable ?? null);
  const progress = active ? (fidelity?.progress ?? card.status ?? "Working") : null;

  return (
    <li data-testid="subagent-fold-row" data-status={status}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <StatusDot tone={STATUS_TONE[status]} pulse={active} />
        <span className="min-w-0 truncate text-[12.5px] font-medium leading-5 text-text-primary">
          {card.title}
        </span>
        {fidelity?.role && (
          <span className="max-w-28 shrink-0 truncate rounded-full border border-border-button-default px-1.5 text-caption-2-medium text-text-tertiary">
            {fidelity.role}
          </span>
        )}
        {/* A settled child that did not complete says so in words, not only in
            the dot's colour. */}
        {!active && status !== "completed" && (
          <span
            className={cn(
              "shrink-0 text-caption-2-medium",
              status === "failed" ? "text-text-error-primary" : "text-text-tertiary",
            )}
          >
            {statusLabel}
          </span>
        )}
        <span className="sr-only">{statusLabel}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
          {elapsed && (
            <span
              data-testid="subagent-elapsed"
              className="text-[11.5px] tabular-nums text-text-tertiary"
            >
              {elapsed}
            </span>
          )}
          <RiArrowDownSLine
            className={cn(
              "size-3.5 text-text-tertiary opacity-70 transition-transform duration-200",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div className="trace-guide mt-0.5 ml-[18px] pl-3" data-testid="subagent-work">
          {meta.length > 0 && (
            <p className={cn(CHILD_META_CLASS, "px-1.5 py-0.5")}>{meta.join(" · ")}</p>
          )}
          {rows.map((row) => (
            <TraceRowView
              key={row.key}
              row={row}
              expanded={stepExpansion[row.key] ?? false}
              onToggle={(key) =>
                setStepExpansion((current) => ({ ...current, [key]: !(current[key] ?? false) }))
              }
              highlighted={false}
            />
          ))}
          {rows.length === 0 && progress && (
            <p className="px-1.5 py-0.5 text-[12.5px] leading-5 text-text-tertiary">{progress}</p>
          )}
          {fidelity?.resultText && <SummaryCard text={fidelity.resultText} />}
        </div>
      )}
    </li>
  );
}
