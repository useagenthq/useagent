"use client";



import {
  RiArrowLeftLine,
  RiRobot2Line,
} from "@remixicon/react";
import { useState } from "react";
import {
  type ChildTimelineEntry,
  deriveChildTimeline,
} from "@/components/chat/canonical-children";
import type {
  CanonicalEventLike,
} from "@/components/chat/canonical-timeline";
import {
  type ChildTreeNode,
} from "@/components/chat/child-tree-projector";
import type { SubagentCard } from "@/components/chat/subagents";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { type ApiStep, deriveTrace } from "@/components/chat/types";
import { formatDuration } from "@/utils/format";
import {
  formatSubagentCostUsd,
  formatSubagentTokenCount,
} from "@/components/session-ui/agent-panel-row";
import {
  ChildStateDot,
  childElapsedMs,
  childStatusLabel,
  isChildActive,
  type RailChildFidelity,
  useNow,
} from "@/components/chat/agent-status";
import { cx as cn } from "@/utils/cx";
import { continueNativeChildAsSession, runCreateFailureMessage } from "@/lib/create-run";
/**
 * The detail view for one subagent card. Its objective is the spawn step's prompt
 * (`deriveTrace(...).detail`); its returned answer is the native result text; its
 * activity is exactly the steps native-attributed to this card (`ownerByStep`).
 */
export function AgentDetail({
  node,
  card,
  fidelity,
  steps,
  ownerByStep,
  spawnStepId,
  canonicalEvents,
  historyLoading,
  parentThreadId = "",
  onBack,
}: {
  node: ChildTreeNode;
  card: SubagentCard;
  fidelity: RailChildFidelity | undefined;
  steps: ApiStep[];
  ownerByStep: ReadonlyMap<string, string>;
  spawnStepId: string;
  canonicalEvents: readonly CanonicalEventLike[];
  historyLoading: boolean;
  parentThreadId?: string;
  onBack: () => void;
}) {
  const status = node.status;
  const live = isChildActive(status);
  const now = useNow(live);
  const elapsed = childElapsedMs(card, now, live, fidelity?.usage?.durationMs ?? null);

  const spawn = steps.find((s) => s.id === spawnStepId);
  const objective = fidelity?.prompt ?? (spawn ? deriveTrace(spawn).detail : null);
  const activity = steps.filter((s) => ownerByStep.get(s.id) === card.id);
  // The child's REAL canonical activity (its own tool lifecycles + text). When
  // present it IS the pane's timeline - durable-attributed steps already resolve
  // into it (same sidecar rule as the conversation), so nothing renders twice.
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const timeline: ChildTimelineEntry[] = deriveChildTimeline(
    canonicalEvents,
    stepsById,
    card.childSessionId,
  );
  const hasActivity = timeline.length > 0 || activity.length > 0;
  const hasAnyChildData =
    hasActivity ||
    (fidelity?.recentActivity.length ?? 0) > 0 ||
    Boolean(fidelity?.resultText) ||
    Boolean(fidelity?.usage);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const canContinueAsSession =
    node.lane === "native" && node.executionId !== null && parentThreadId.length > 0;

  const continueAsSession = async (): Promise<void> => {
    if (!node.executionId || continuing) return;
    setContinuing(true);
    setContinueError(null);
    try {
      const response = await continueNativeChildAsSession(
        parentThreadId,
        node.executionId,
        `Continue ${node.title}`.slice(0, 160),
      );
      if (!response.ok) {
        throw new Error(await runCreateFailureMessage(response, "Could not continue this child"));
      }
      const body = (await response.json()) as { thread_id?: unknown };
      if (typeof body.thread_id !== "string" || !body.thread_id) {
        throw new Error("Continuation response did not include a child thread");
      }
      window.location.assign(`/session/${body.thread_id}`);
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : "Could not continue this child");
      setContinuing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-border-button-default flex shrink-0 items-start gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents list"
          className="text-text-secondary hover:bg-background-secondary-hover mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
        </button>
        <span className="bg-background-secondary-default text-foreground-icon-secondary mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
          <RiRobot2Line className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body-2-medium text-text-primary min-w-0 flex-1 truncate">
              {card.title}
            </span>
            <ChildStateDot status={status} />
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-mono-label text-text-tertiary flex-1">
              Native · {node.provider ?? fidelity?.role ?? "Subagent"}
              {node.model ? ` · ${node.model}` : ""}
              {` · ${childStatusLabel(status, fidelity?.resumable ?? null)}`}
            </span>
            {elapsed !== null && (
              <span className="text-text-tertiary shrink-0 font-mono text-caption-1-medium tabular-nums">
                {formatDuration(elapsed)}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {objective && objective !== card.title && (
          <section className="border-border-button-default border-b pb-3">
            <p className="text-mono-label text-text-tertiary mb-1">Prompt</p>
            <p className="text-body-2-regular text-text-secondary whitespace-pre-wrap break-words">
              {objective}
            </p>
          </section>
        )}

        {fidelity?.resultText && (
          <div
            className={cn(
              "rounded-xl border p-3",
              status === "failed"
                ? "border-border-error-default/30 bg-red-50"
                : "border-border-button-default bg-background-secondary-default",
            )}
          >
            <p className="text-mono-label text-text-tertiary mb-1">
              {status === "failed" ? "Error" : "Answer"}
            </p>
            <p
              className={cn(
                "text-body-2-regular whitespace-pre-wrap break-words",
                status === "failed" ? "text-red-500" : "text-text-primary",
              )}
            >
              {fidelity.resultText}
            </p>
          </div>
        )}

        {(fidelity?.usage ||
          fidelity?.lastToolName ||
          fidelity?.model ||
          fidelity?.role ||
          fidelity?.resumable != null) && (
          <div className="text-mono-label text-text-tertiary flex flex-wrap gap-x-3 gap-y-1">
            {fidelity.lastToolName && <span>Last tool: {fidelity.lastToolName}</span>}
            {fidelity.usage && (
              <span>{formatSubagentTokenCount(fidelity.usage.totalTokens)} tokens</span>
            )}
            {fidelity.usage?.costUsd !== undefined && (
              <span>{formatSubagentCostUsd(fidelity.usage.costUsd)}</span>
            )}
            {fidelity?.usage?.toolUses !== undefined && (
              <span>{fidelity.usage.toolUses} tool uses</span>
            )}
            {fidelity.role && <span>Role: {fidelity.role}</span>}
            {fidelity.model && <span>Model: {fidelity.model}</span>}
            {fidelity.resumable !== undefined && fidelity.resumable !== null && (
              <span>{fidelity.resumable ? "Resumable" : "Not resumable"}</span>
            )}
          </div>
        )}

        <section aria-label="Child controls" className="border-border-button-default border-t pt-3">
          <p className="text-mono-label text-text-tertiary mb-1">Controls</p>
          {canContinueAsSession ? (
            <button
              type="button"
              disabled={continuing}
              onClick={() => void continueAsSession()}
              className="border-border-button-default bg-background-secondary-default text-body-2-medium text-text-primary hover:bg-background-tertiary-hover mb-2 rounded-lg border px-3 py-2 disabled:cursor-wait disabled:opacity-60"
            >
              {continuing ? "Creating session…" : "Continue as session"}
            </button>
          ) : null}
          {continueError ? (
            <p role="alert" className="text-caption-1-regular text-text-error-primary mb-2">
              {continueError}
            </p>
          ) : null}
          <ul className="space-y-1">
            {(["resume", "cancel", "steer"] as const).map((control) => (
              <li key={control} className="text-caption-1-regular text-text-tertiary">
                <span className="capitalize">{control}</span> unavailable: {node.controls[control].reason}
              </li>
            ))}
          </ul>
        </section>

        {timeline.length > 0 ? (
          /* The child's own canonical timeline: its tool calls and returned text
             in true order - never a bare status line when real activity exists. */
          <div className="space-y-2.5">
            {timeline.map((entry, i) =>
              entry.kind === "text" ? (
                <p
                  key={entry.key}
                  className="text-body-2-regular text-text-secondary whitespace-pre-wrap break-words"
                >
                  {entry.text}
                </p>
              ) : (
                <ToolStepRow
                  key={entry.key}
                  step={entry.step}
                  state={live && i === timeline.length - 1 ? "running" : "done"}
                  nested={false}
                />
              ),
            )}
          </div>
        ) : activity.length > 0 || (fidelity?.recentActivity.length ?? 0) > 0 ? (
          <div className="space-y-2.5">
            {fidelity?.recentActivity.map((entry, index) => (
              <div
                key={`${entry.at}:${index}:${entry.summary}`}
                className="border-border-button-default bg-background-secondary-default rounded-lg border px-3 py-2"
              >
                <p className="text-caption-1-regular text-text-secondary break-words">{entry.summary}</p>
              </div>
            ))}
            {activity.map((step, i) => (
              <ToolStepRow
                key={step.id}
                step={step}
                state={live && i === activity.length - 1 ? "running" : "done"}
                nested={false}
              />
            ))}
          </div>
        ) : historyLoading ? (
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            Loading child history…
          </p>
        ) : live ? (
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            Waiting for the first native activity…
          </p>
        ) : hasAnyChildData ? null : (
          /* Truly nothing known beyond the terminal state - only then a status line. */
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            No child transcript/result captured.
          </p>
        )}
      </div>
    </div>
  );
}
