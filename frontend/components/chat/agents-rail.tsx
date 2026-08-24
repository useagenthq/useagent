"use client";

import {
  RiArrowLeftLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiRobot2Line,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import {
  type ChildTimelineEntry,
  deriveChildrenView,
  deriveChildTimeline,
  legacySpawnStepIdForCanonical,
  type MergedChildFidelity,
} from "@/components/chat/canonical-children";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import {
  firstLine,
  type GatewayChildSession,
  RUN_CHILD_STATUS,
  RUN_STATUS_LABEL,
} from "@/components/chat/gateway-children";
import type { ChildStatus, NativeFrame } from "@/components/chat/native-events";
import type { SubagentCard } from "@/components/chat/subagents";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { type ApiStep, deriveTrace } from "@/components/chat/types";
import { formatDuration } from "@/utils/format";
import {
  formatSubagentCostUsd,
  formatSubagentTokenCount,
  AgentPanelRow,
} from "@/components/session-ui/agent-panel-row";
import { cx as cn } from "@/utils/cx";

/**
 * The right-rail "Agents" tab: one card per fanned-out subagent, mirroring
 * the reference tool's session view. Each card renders through the vendored T3 fleet row
 * (`session-ui/agent-panel-row`): status dot, current/last activity line, elapsed,
 * token usage when known, result preview once settled — and, crucially, its OWN
 * run-state.
 *
 * Cards, step attribution, and per-child fidelity all come from the ONE merged
 * projection (`deriveChildrenView`): canonical child lifecycle events name the
 * cards when present (legacy spawn steps otherwise), durable steps attribute by
 * exact native child session, and fidelity is canonical-first with the native
 * frame lane as fallback — so a failed child reads failed while its siblings
 * complete, instead of every card sharing the parent run's liveness. When no
 * lane carries a status, it falls back to the run's liveness. The inline
 * conversation fold (`subagents-fold.tsx`) reads the same projection.
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
function statusOf(fidelity: RailChildFidelity | undefined, runLive: boolean): ChildStatus {
  return fidelity?.status ?? (runLive ? "running" : "completed");
}

export const isChildActive = (status: ChildStatus): boolean =>
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

type RailChildFidelity = MergedChildFidelity;

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
    return <RiErrorWarningLine className="text-red-500 size-4 shrink-0" aria-label="failed" />;
  }
  return <RiCheckLine className="text-lime-600 size-4 shrink-0" aria-label="completed" />;
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

  return (
    <AgentPanelRow
      agent={{
        title: card.title,
        role: fidelity?.role ?? null,
        engine: null,
        model: fidelity?.model ?? null,
        status,
        statusLabel: childStatusLabel(status, fidelity?.resumable ?? null),
        progress: fidelity?.progress ?? null,
        lastToolName: fidelity?.lastToolName ?? null,
        lastStepLabel: card.status,
        result: fidelity?.resultText ?? null,
        usage: fidelity?.usage ?? null,
        elapsed: elapsed !== null ? formatDuration(elapsed) : null,
      }}
      onOpen={onOpen}
    />
  );
}

/**
 * A gateway child session (spawned via child_session_create) as a rail card. It
 * is its OWN run - a deferred serial thread turn - so the card links to that
 * session rather than opening an in-rail detail. Identity is real: the child's
 * prompt is the title, its engine + model ride the meta caption, and its
 * queued/running/settled state (plus any summary) reads on the caption line.
 */
function GatewayAgentCard({ child }: { child: GatewayChildSession }) {
  const status = RUN_CHILD_STATUS[child.status];
  const summaryLine = child.summary ? firstLine(child.summary) : null;
  // Active rows lead with their queue/run state (there is no glyph yet); settled
  // rows lead with the summary (the dot/check already conveys the outcome). The
  // row's own status-label fallback covers a settled child with no summary.
  const result = isChildActive(status) ? RUN_STATUS_LABEL[child.status] : summaryLine;

  return (
    <AgentPanelRow
      href={`/session/${child.id}`}
      agent={{
        title: child.prompt,
        role: null,
        engine: child.engine,
        model: child.model,
        status,
        statusLabel: RUN_STATUS_LABEL[child.status],
        progress: null,
        lastToolName: null,
        lastStepLabel: null,
        result,
        usage: null,
        elapsed: null,
      }}
    />
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
  canonicalEvents,
  onBack,
}: {
  card: SubagentCard;
  fidelity: RailChildFidelity | undefined;
  runLive: boolean;
  steps: ApiStep[];
  ownerByStep: ReadonlyMap<string, string>;
  spawnStepId: string;
  canonicalEvents: readonly CanonicalEventLike[];
  onBack: () => void;
}) {
  const status = statusOf(fidelity, runLive);
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
              {fidelity?.role ?? "Subagent"}
              {status === "failed" ? " · failed" : ""}
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
        ) : live ? (
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            Waiting for the first native activity…
          </p>
        ) : hasAnyChildData ? null : (
          /* Truly nothing known beyond the terminal state - only then a status line. */
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            {childStatusLabel(status, fidelity?.resumable ?? null)}
          </p>
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
  childSessions = [],
}: {
  steps: ApiStep[];
  live: boolean;
  frames?: readonly NativeFrame[];
  canonicalEvents?: readonly CanonicalEventLike[];
  /** Gateway child sessions across the thread (child_session_create fan-out).
   *  Their own runs, so they render as link cards to their session. */
  childSessions?: readonly GatewayChildSession[];
}) {
  // ONE merged projection (canonical + legacy steps + native frames) - the same
  // view the inline conversation fold reads, so the two surfaces never disagree.
  const { cards, ownerByStep, fidelity, legacy } = deriveChildrenView(
    steps,
    frames,
    canonicalEvents,
  );
  // Gateway children are product runs with richer identity than the parent
  // lifecycle receipt. Prefer their row when both lanes name the same child.
  const gatewayIds = new Set(childSessions.map((child) => child.id));
  const nativeCards = cards.filter(
    (card) => !card.aliases.some((alias) => gatewayIds.has(alias)),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fallback liveness for cards without a native status frame: the run is live
  // and hasn't emitted its terminal `done` step.
  const runLive = live && !steps.some((s) => s.kind === "done");

  if (nativeCards.length === 0 && childSessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-body-2-regular text-text-tertiary text-center">
          No subagents in this conversation yet.
        </p>
      </div>
    );
  }

  // Selection survives live re-derivation because card ids are stable.
  const selected = selectedId ? nativeCards.find((c) => c.id === selectedId) : null;
  if (selected) {
    const f = fidelityFor(selected, fidelity);
    // A legacy card's id IS its spawn step; a canonical card resolves through the
    // legacy projection's aliases (falling back to its own id when none matches).
    const spawnStepId = legacySpawnStepIdForCanonical(selected, legacy) ?? selected.id;
    return (
      <AgentDetail
        card={selected}
        fidelity={f}
        runLive={runLive}
        steps={steps}
        ownerByStep={ownerByStep}
        spawnStepId={spawnStepId}
        canonicalEvents={canonicalEvents}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="h-full space-y-2 overflow-y-auto p-3" data-testid="agents-rail">
      {nativeCards.map((card) => (
        <AgentCardRow
          key={card.id}
          card={card}
          fidelity={fidelityFor(card, fidelity)}
          runLive={runLive}
          onOpen={() => setSelectedId(card.id)}
        />
      ))}
      {childSessions.map((child) => (
        <GatewayAgentCard key={child.id} child={child} />
      ))}
    </div>
  );
}
