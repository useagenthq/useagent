"use client";

import { useEffect, useState } from "react";
import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiRobot2Line,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { deriveTrace, formatDuration, type ApiStep } from "@/components/chat/types";
import { deriveSubagents, type SubagentCard } from "@/components/chat/subagents";
import {
  deriveChildFidelity,
  type ChildFidelity,
  type ChildStatus,
  type NativeFrame,
} from "@/components/chat/native-events";

/**
 * The right-rail "Agents" tab: one card per fanned-out subagent, mirroring
 * the reference tool's session view. Each card shows the subagent's description, a live status
 * line, an elapsed timer, and — crucially — its OWN run-state.
 *
 * Cards + nested activity are derived from the ordered step stream via
 * `deriveSubagents` (native child-session attribution, not display order). Each
 * card's status (running/completed/failed) and returned answer come from the
 * native event lane via `deriveChildFidelity`, keyed by the parent's task-tool
 * call id — so a failed child reads failed while its siblings complete, instead
 * of every card sharing the parent run's liveness. When no native frame is
 * available (pre-native runs, or before the lane loads) status falls back to the
 * run's liveness. See `native-events.ts` and `subagents.ts`.
 *
 * Cards are openable: selecting one swaps this rail to a detail view of THAT
 * subagent — objective, status, its returned answer, and only its own
 * native-attributed activity. Back returns to the list.
 */

/** Ticks once a second while `live`, so elapsed timers advance; frozen otherwise. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** Elapsed ms this card has been (or was) active; frozen once it settles. */
function elapsedOf(card: SubagentCard, now: number, live: boolean): number {
  const endedAt = live ? now : (card.lastActivityAt ?? card.startedAt);
  return Number.isFinite(card.startedAt) ? Math.max(0, endedAt - card.startedAt) : 0;
}

/** Resolve a card's authoritative status: native fidelity first, else fall back
 *  to the parent run's liveness (pre-native runs / before the lane loads). */
function statusOf(card: SubagentCard, fidelity: ChildFidelity | undefined, runLive: boolean): ChildStatus {
  return fidelity?.status ?? (runLive ? "running" : "completed");
}

/** Per-child state indicator: running pulse / completed check / failed warning. */
function ChildStateDot({ status }: { status: ChildStatus }) {
  if (status === "running") {
    return (
      <span
        className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full"
        aria-label="running"
      />
    );
  }
  if (status === "failed") {
    return <RiErrorWarningLine className="text-error-base size-4 shrink-0" aria-label="failed" />;
  }
  return <RiCheckLine className="text-success-base size-4 shrink-0" aria-label="completed" />;
}

function AgentCardRow({
  card,
  status,
  onOpen,
}: {
  card: SubagentCard;
  status: ChildStatus;
  onOpen: () => void;
}) {
  const live = status === "running";
  const now = useNow(live);
  const elapsed = elapsedOf(card, now, live);
  const statusLine =
    status === "failed"
      ? (card.status ?? "Failed")
      : (card.status ?? (live ? "Starting…" : "No activity recorded"));

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="subagent-card"
      aria-label={`Open subagent: ${card.title}`}
      className="bg-bg-weak-50 border-stroke-soft-200 hover:bg-bg-soft-200 animate-ai-fade-up flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors"
    >
      <span className="bg-feature-lighter text-feature-base mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
        <RiRobot2Line className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
            {card.title}
          </span>
          <ChildStateDot status={status} />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "text-paragraph-xs min-w-0 flex-1 truncate",
              status === "failed" ? "text-error-base" : "text-text-sub-600",
              live && card.status && "agent-progress-loading-text",
            )}
          >
            {statusLine}
          </span>
          <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
            {formatDuration(elapsed)}
          </span>
        </div>
      </div>
      <RiArrowRightSLine className="text-text-soft-400 size-4 shrink-0 self-center" aria-hidden />
    </button>
  );
}

/**
 * The detail view for one subagent card. Its objective is the spawn step's prompt
 * (`deriveTrace(...).detail`); its returned answer is the native result text; its
 * activity is exactly the steps native-attributed to this card (`ownerByStep`).
 */
function AgentDetail({
  card,
  status,
  resultText,
  steps,
  ownerByStep,
  onBack,
}: {
  card: SubagentCard;
  status: ChildStatus;
  resultText: string | null;
  steps: ApiStep[];
  ownerByStep: ReadonlyMap<string, string>;
  onBack: () => void;
}) {
  const live = status === "running";
  const now = useNow(live);
  const elapsed = elapsedOf(card, now, live);

  const spawn = steps.find((s) => s.id === card.id);
  const objective = spawn ? deriveTrace(spawn).detail : null;
  const activity = steps.filter((s) => ownerByStep.get(s.id) === card.id);

  return (
    <div className="flex h-full flex-col">
      <header className="border-stroke-soft-200 flex shrink-0 items-start gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents list"
          className="text-text-sub-600 hover:bg-bg-soft-200 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
        </button>
        <span className="bg-feature-lighter text-feature-base mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
          <RiRobot2Line className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
              {card.title}
            </span>
            <ChildStateDot status={status} />
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-mono-label text-text-soft-400 flex-1">
              Subagent{status === "failed" ? " · failed" : ""}
            </span>
            <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
              {formatDuration(elapsed)}
            </span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {objective && objective !== card.title && (
          <p className="text-paragraph-sm text-text-sub-600 border-stroke-soft-200 border-b pb-3">
            {objective}
          </p>
        )}

        {resultText && (
          <div
            className={cn(
              "rounded-xl border p-3",
              status === "failed"
                ? "border-error-base/30 bg-error-lighter"
                : "border-stroke-soft-200 bg-bg-weak-50",
            )}
          >
            <p className="text-mono-label text-text-soft-400 mb-1">
              {status === "failed" ? "Error" : "Answer"}
            </p>
            <p
              className={cn(
                "text-paragraph-sm whitespace-pre-wrap break-words",
                status === "failed" ? "text-error-base" : "text-text-strong-950",
              )}
            >
              {resultText}
            </p>
          </div>
        )}

        {activity.length === 0 ? (
          <p className="text-paragraph-sm text-text-soft-400 py-6 text-center">
            {live ? "Waiting for the first step…" : "No activity recorded."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {activity.map((step, i) => (
              <ToolStepRow
                key={step.id}
                step={step}
                state={live && i === activity.length - 1 ? "running" : "done"}
                nested={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentsRail({
  steps,
  live,
  frames = [],
}: {
  steps: ApiStep[];
  live: boolean;
  frames?: readonly NativeFrame[];
}) {
  const { cards, ownerByStep } = deriveSubagents(steps);
  const fidelity = deriveChildFidelity(frames);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fallback liveness for cards without a native status frame: the run is live
  // and hasn't emitted its terminal `done` step.
  const runLive = live && !steps.some((s) => s.kind === "done");

  if (cards.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-paragraph-sm text-text-soft-400 text-center">
          No subagents in this conversation yet.
        </p>
      </div>
    );
  }

  // Selection survives live re-derivation because card ids are stable.
  const selected = selectedId ? cards.find((c) => c.id === selectedId) : null;
  if (selected) {
    const f = selected.callId ? fidelity.get(selected.callId) : undefined;
    return (
      <AgentDetail
        card={selected}
        status={statusOf(selected, f, runLive)}
        resultText={f?.resultText ?? null}
        steps={steps}
        ownerByStep={ownerByStep}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="h-full space-y-2.5 overflow-y-auto p-3" data-testid="agents-rail">
      {cards.map((card) => (
        <AgentCardRow
          key={card.id}
          card={card}
          status={statusOf(card, card.callId ? fidelity.get(card.callId) : undefined, runLive)}
          onOpen={() => setSelectedId(card.id)}
        />
      ))}
    </div>
  );
}
