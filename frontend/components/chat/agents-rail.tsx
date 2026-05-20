"use client";

import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiRobot2Line,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  type CanonicalChildFidelity,
  deriveCanonicalChildren,
  legacySpawnStepIdForCanonical,
  remapCanonicalOwnerByStep,
} from "@/components/chat/canonical-children";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import {
  type ChildFidelity,
  type ChildStatus,
  deriveChildFidelity,
  type NativeFrame,
} from "@/components/chat/native-events";
import { deriveSubagents, type SubagentCard } from "@/components/chat/subagents";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { type ApiStep, deriveTrace, formatDuration } from "@/components/chat/types";
import { cnExt as cn } from "@/utils/cn";

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
export function childElapsedMs(
  card: SubagentCard,
  now: number,
  live: boolean,
  providerDurationMs: number | null,
): number | null {
  if (!live && providerDurationMs !== null && Number.isFinite(providerDurationMs) && providerDurationMs > 0) {
    return providerDurationMs;
  }
  // Canonical translation currently falls back to the provider sequence when no
  // wall-clock timestamp exists. Never present that sequence delta as a duration.
  if (!Number.isFinite(card.startedAt) || card.startedAt < Date.UTC(2000, 0, 1)) return null;
  const endedAt = live ? now : (card.lastActivityAt ?? card.startedAt);
  const elapsed = Math.max(0, endedAt - card.startedAt);
  return elapsed > 0 ? elapsed : null;
}

/** Resolve a card's authoritative status: native fidelity first, else fall back
 *  to the parent run's liveness (pre-native runs / before the lane loads). */
function statusOf(fidelity: ChildFidelity | undefined, runLive: boolean): ChildStatus {
  return fidelity?.status ?? (runLive ? "running" : "completed");
}

const isChildActive = (status: ChildStatus): boolean =>
  status === "pending" || status === "running" || status === "waiting";

export const childStatusLabel = (status: ChildStatus, resumable: boolean | null = null): string => {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return resumable === false ? "Idle" : "Idle · resumable";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      status satisfies never;
      return "Unknown";
  }
};

type RailChildFidelity = ChildFidelity &
  Partial<Pick<CanonicalChildFidelity, "model" | "role" | "resumable">>;

const compactCount = (value: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function fidelityFor(
  card: SubagentCard,
  fidelity: ReadonlyMap<string, RailChildFidelity>,
): RailChildFidelity | undefined {
  for (const id of card.aliases) {
    const match = fidelity.get(id);
    if (match) return match;
  }
  return undefined;
}

/** Per-child state indicator: running pulse / completed check / failed warning. */
function ChildStateDot({ status }: { status: ChildStatus }) {
  if (isChildActive(status)) {
    return (
      <span
        className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full"
        role="status"
        aria-label="running"
      />
    );
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <RiErrorWarningLine className="text-error-base size-4 shrink-0" aria-label="failed" />;
  }
  return <RiCheckLine className="text-success-base size-4 shrink-0" aria-label="completed" />;
}

function AgentCardRow({
  card,
  fidelity,
  runLive,
  onOpen,
}: {
  card: SubagentCard;
  fidelity: RailChildFidelity | undefined;
  runLive: boolean;
  onOpen: () => void;
}) {
  const status = statusOf(fidelity, runLive);
  const live = isChildActive(status);
  const now = useNow(live);
  const elapsed = childElapsedMs(card, now, live, fidelity?.usage?.durationMs ?? null);
  const statusLine =
    fidelity?.progress ?? card.status ?? childStatusLabel(status, fidelity?.resumable ?? null);

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
          {(fidelity?.usage || elapsed !== null) && (
            <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
              {fidelity?.usage ? `${compactCount(fidelity.usage.totalTokens)} tok` : ""}
              {fidelity?.usage && elapsed !== null ? " · " : ""}
              {elapsed !== null ? formatDuration(elapsed) : ""}
            </span>
          )}
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
  fidelity,
  runLive,
  steps,
  ownerByStep,
  spawnStepId,
  onBack,
}: {
  card: SubagentCard;
  fidelity: RailChildFidelity | undefined;
  runLive: boolean;
  steps: ApiStep[];
  ownerByStep: ReadonlyMap<string, string>;
  spawnStepId: string;
  onBack: () => void;
}) {
  const status = statusOf(fidelity, runLive);
  const live = isChildActive(status);
  const now = useNow(live);
  const elapsed = childElapsedMs(card, now, live, fidelity?.usage?.durationMs ?? null);

  const spawn = steps.find((s) => s.id === spawnStepId);
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
              {fidelity?.role ?? "Subagent"}
              {status === "failed" ? " · failed" : ""}
            </span>
            {elapsed !== null && (
              <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
                {formatDuration(elapsed)}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {objective && objective !== card.title && (
          <p className="text-paragraph-sm text-text-sub-600 border-stroke-soft-200 border-b pb-3">
            {objective}
          </p>
        )}

        {fidelity?.resultText && (
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
              {fidelity.resultText}
            </p>
          </div>
        )}

        {(fidelity?.usage ||
          fidelity?.lastToolName ||
          fidelity?.model ||
          fidelity?.role ||
          fidelity?.resumable != null) && (
          <div className="text-mono-label text-text-soft-400 flex flex-wrap gap-x-3 gap-y-1">
            {fidelity.lastToolName && <span>Last tool: {fidelity.lastToolName}</span>}
            {fidelity.usage && <span>{compactCount(fidelity.usage.totalTokens)} tokens</span>}
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

        {activity.length === 0 && (fidelity?.recentActivity.length ?? 0) === 0 ? (
          <p className="text-paragraph-sm text-text-soft-400 py-6 text-center">
            {live
              ? "Waiting for the first native activity…"
              : childStatusLabel(status, fidelity?.resumable ?? null)}
          </p>
        ) : (
          <div className="space-y-2.5">
            {fidelity?.recentActivity.map((entry, index) => (
              <div
                key={`${entry.at}:${index}:${entry.summary}`}
                className="border-stroke-soft-200 bg-bg-weak-50 rounded-lg border px-3 py-2"
              >
                <p className="text-paragraph-xs text-text-sub-600 break-words">{entry.summary}</p>
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
        )}
      </div>
    </div>
  );
}

export function AgentsRail({
  steps,
  live,
  frames = [],
  canonicalEvents = [],
}: {
  steps: ApiStep[];
  live: boolean;
  frames?: readonly NativeFrame[];
  canonicalEvents?: readonly CanonicalEventLike[];
}) {
  const canonical = deriveCanonicalChildren(canonicalEvents);
  const legacy = deriveSubagents(steps);
  const hasCanonicalChildren = canonical.cards.length > 0;
  const cards = hasCanonicalChildren ? canonical.cards : legacy.cards;
  const ownerByStep = hasCanonicalChildren
    ? remapCanonicalOwnerByStep(canonical.cards, legacy)
    : legacy.ownerByStep;
  const fidelity = hasCanonicalChildren ? canonical.fidelity : deriveChildFidelity(frames);
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
    const f = fidelityFor(selected, fidelity);
    const spawnStepId = hasCanonicalChildren
      ? (legacySpawnStepIdForCanonical(selected, legacy) ?? selected.id)
      : selected.id;
    return (
      <AgentDetail
        card={selected}
        fidelity={f}
        runLive={runLive}
        steps={steps}
        ownerByStep={ownerByStep}
        spawnStepId={spawnStepId}
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
          fidelity={fidelityFor(card, fidelity)}
          runLive={runLive}
          onOpen={() => setSelectedId(card.id)}
        />
      ))}
    </div>
  );
}
