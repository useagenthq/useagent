"use client";

import {
  RiArrowLeftLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiRobot2Line,
} from "@remixicon/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionSummarySnapshot } from "@useagent/agent-client";
import {
  type ChildTimelineEntry,
  deriveChildTimeline,
  legacySpawnStepIdForCanonical,
  type MergedChildFidelity,
} from "@/components/chat/canonical-children";
import type {
  CanonicalEventLike,
} from "@/components/chat/canonical-timeline";
import { deriveChildrenViewFromExecutionSummary } from "@/components/chat/execution-summary-rollout";
import {
  EXECUTION_GRAPH_CLIENT_MODE,
  executionHistoryKey,
  fetchExecutionGraph,
  fetchExecutionTranscriptById,
  mergeExecutionTranscript,
  type ExecutionGraphResponse,
} from "@/components/chat/execution-graph-client";
import {
  type ChildTreeNode,
  projectChildTree,
} from "@/components/chat/child-tree-projector";
import {
  firstLine,
  type GatewayChildSession,
  RUN_STATUS_LABEL,
} from "@/components/chat/gateway-children";
import type { ChildStatus, NativeFrame } from "@/components/chat/native-events";
import type { SubagentCard } from "@/components/chat/subagents";
import type { ThreadRelationship } from "@useagent/agent-client";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { type ApiStep, deriveTrace } from "@/components/chat/types";
import { useProductChildGraphs } from "@/components/chat/use-product-child-graphs";
import { formatDuration } from "@/utils/format";
import {
  formatSubagentCostUsd,
  formatSubagentTokenCount,
  AgentPanelRow,
} from "@/components/session-ui/agent-panel-row";
import { cx as cn } from "@/utils/cx";
import { continueNativeChildAsSession, runCreateFailureMessage } from "@/lib/create-run";

/**
 * The right-rail "Agents" tab: one card per fanned-out subagent, mirroring
 * a live session view. Each card renders through the vendored T3 fleet row
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

interface VisibleChildNode {
  readonly node: ChildTreeNode;
  readonly level: number;
  readonly parentId: string | null;
  readonly position: number;
  readonly setSize: number;
}

function visibleChildNodes(
  roots: readonly ChildTreeNode[],
  collapsed: ReadonlySet<string>,
): VisibleChildNode[] {
  const visible: VisibleChildNode[] = [];
  const visit = (siblings: readonly ChildTreeNode[], level: number, parentId: string | null) => {
    siblings.forEach((node, index) => {
      visible.push({ node, level, parentId, position: index + 1, setSize: siblings.length });
      if (!collapsed.has(node.id)) visit(node.children, level + 1, node.id);
    });
  };
  visit(roots, 1, null);
  return visible;
}

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

function ChildTreeRow({
  node,
  onOpen,
  treeItem,
}: {
  node: ChildTreeNode;
  onOpen: () => void;
  treeItem: NonNullable<Parameters<typeof AgentPanelRow>[0]["treeItem"]>;
}) {
  const live = isChildActive(node.status);
  const now = useNow(live);
  const elapsed = node.nativeCard
    ? childElapsedMs(node.nativeCard, now, live, node.elapsedMs)
    : node.elapsedMs;
  const gatewaySummary = node.gatewayChild?.summary ? firstLine(node.gatewayChild.summary) : null;
  const result = node.lane === "gateway"
    ? isChildActive(node.status)
      ? RUN_STATUS_LABEL[node.gatewayChild?.status ?? "running"]
      : gatewaySummary
    : node.result;

  return (
    <AgentPanelRow
      href={node.productRelationship
        ? `/session/${node.productRelationship.threadId}`
        : node.gatewayChild
          ? `/session/${node.gatewayChild.id}`
          : undefined}
      agent={{
        title: node.title,
        role: node.role,
        engine: node.engine,
        provider: node.provider,
        model: node.model,
        status: node.status,
        statusLabel: childStatusLabel(node.status),
        progress: node.progress,
        lastToolName: node.lastToolName,
        lastStepLabel: node.prompt !== node.title
          ? node.prompt
          : isChildActive(node.status)
            ? node.nativeCard?.status ?? null
            : null,
        result,
        usage: node.usage,
        elapsed: elapsed !== null ? formatDuration(elapsed) : null,
        lane: node.lane,
        childCount: node.childCount,
      }}
      onOpen={onOpen}
      treeItem={treeItem}
    />
  );
}

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

/** Resolve a durable execution id to its exact tree node, never by provider session id. */
export function focusNodeIdFor(
  nodes: readonly ChildTreeNode[],
  focusExecutionId: string | null,
): string | null {
  if (!focusExecutionId) return null;
  for (const node of nodes) {
    if (node.executionId === focusExecutionId) return node.id;
    const nested = focusNodeIdFor(node.children, focusExecutionId);
    if (nested) return nested;
  }
  return null;
}
export function AgentsRail({
  rootRunId = null,
  parentThreadId = null,
  steps,
  live,
  frames = [],
  canonicalEvents = [],
  executionSummary = null,
  childSessions = [],
  productChildren = [],
  focusExecutionId = null,
  focusExecutionRunId = null,
  onClearNativeSessionFocus,
}: {
  rootRunId?: string | null;
  parentThreadId?: string | null;
  steps: ApiStep[];
  live: boolean;
  frames?: readonly NativeFrame[];
  canonicalEvents?: readonly CanonicalEventLike[];
  executionSummary?: ExecutionSummarySnapshot | null;
  /** Gateway child sessions across the thread (child_session_create fan-out).
   *  Their own runs, so they render as link cards to their session. */
  childSessions?: readonly GatewayChildSession[];
  /** Ordinary messageable child threads. These are the primary product lane. */
  productChildren?: readonly ThreadRelationship[];
  /** Inspect-only native child selected from the persistent sidebar. */
  focusExecutionId?: string | null;
  focusExecutionRunId?: string | null;
  onClearNativeSessionFocus?: () => void;
}) {
  // ONE merged projection (canonical + legacy steps + native frames) - the same
  // view the inline conversation fold reads, so the two surfaces never disagree.
  const { cards, ownerByStep, fidelity, legacy } = deriveChildrenViewFromExecutionSummary(
    steps,
    frames,
    canonicalEvents,
    executionSummary,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const appliedFocusRef = useRef<string | null>(null);
  const [graph, setGraph] = useState<ExecutionGraphResponse | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeTreeId, setActiveTreeId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [lazyHistory, setLazyHistory] = useState<{
    readonly key: string;
    readonly events: readonly CanonicalEventLike[];
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Fallback liveness for cards without a native status frame: the run is live
  // and hasn't emitted its terminal `done` step.
  const runLive = live && !steps.some((s) => s.kind === "done");

  const latestCanonical = canonicalEvents.at(-1);
  const graphRefreshKey = [
    latestCanonical
      ? `${latestCanonical.seq}:${latestCanonical.kind}:${latestCanonical.status ?? ""}:${latestCanonical.nativeStatus ?? ""}`
      : "none",
    ...(executionSummary?.children.map((child) =>
      `${child.id}:${child.lastActivitySeq}:${child.status}`
    ) ?? []),
  ].join("|");
  const graphRunId = focusExecutionRunId ?? rootRunId;

  useEffect(() => {
    if (EXECUTION_GRAPH_CLIENT_MODE !== "read" || !graphRunId) {
      setGraph(null);
      return;
    }
    const controller = new AbortController();
    void fetchExecutionGraph(graphRunId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setGraph(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGraph(null);
      });
    return () => controller.abort();
  }, [graphRunId, cards.length, graphRefreshKey]);

  const productGraphs = useProductChildGraphs(productChildren, collapsed);

  const tree = useMemo(
    () => projectChildTree({
      cards,
      fidelity,
      gatewayChildren: childSessions,
      productChildren,
      productGraphs,
      graph,
      delegationEdges: executionSummary?.delegationEdges,
      canonicalEvents,
      runLive,
    }),
    [cards, fidelity, childSessions, productChildren, productGraphs, graph, executionSummary, canonicalEvents, runLive],
  );
  const visible = useMemo(() => visibleChildNodes(tree, collapsed), [tree, collapsed]);
  const allNodes = useMemo(() => {
    const byId = new Map<string, ChildTreeNode>();
    const add = (nodes: readonly ChildTreeNode[]) => {
      for (const node of nodes) {
        byId.set(node.id, node);
        add(node.children);
      }
    };
    add(tree);
    return byId;
  }, [tree]);
  const focusNodeId = focusNodeIdFor(tree, focusExecutionId);
  useEffect(() => {
    if (!focusExecutionId) {
      if (appliedFocusRef.current !== null) {
        appliedFocusRef.current = null;
        setSelectedId(null);
      }
      return;
    }
    if (!focusNodeId || appliedFocusRef.current === focusExecutionId) return;
    appliedFocusRef.current = focusExecutionId;
    setSelectedId(focusNodeId);
  }, [focusExecutionId, focusNodeId]);
  const selectedNode = selectedId ? allNodes.get(selectedId) ?? null : null;
  const selected = selectedNode?.nativeCard ?? (selectedNode?.executionId
    ? {
        id: selectedNode.id,
        title: selectedNode.title,
        childSessionId: selectedNode.aliases.find((alias) => alias !== selectedNode.executionId) ?? null,
        callId: selectedNode.executionId,
        aliases: selectedNode.aliases,
        status: selectedNode.status,
        startedAt: 0,
        lastActivityAt: null,
      } satisfies SubagentCard
    : null);
  const selectedRunId = selectedNode?.executionRunId ?? graphRunId;

  useEffect(() => {
    if (
      EXECUTION_GRAPH_CLIENT_MODE !== "read" ||
      !selectedRunId ||
      !selectedNode?.executionId
    ) {
      setHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const key = executionHistoryKey(selectedRunId, selectedNode.executionId);
    setLazyHistory((current) => current?.key === key ? current : null);
    setHistoryLoading(true);
    void fetchExecutionTranscriptById(
      selectedRunId,
      selectedNode.executionId,
      controller.signal,
      (events) => {
        if (!controller.signal.aborted) setLazyHistory({ key, events });
      },
    )
      .then((events) => {
        if (!controller.signal.aborted) {
          setLazyHistory(events ? { key, events } : null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLazyHistory(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [selectedRunId, selectedNode?.executionId]);

  const detailEvents = useMemo(() => {
    if (
      !selected ||
      !selectedRunId ||
      !selectedNode?.executionId ||
      lazyHistory?.key !== executionHistoryKey(selectedRunId, selectedNode.executionId)
    ) return canonicalEvents;
    return mergeExecutionTranscript(lazyHistory.events, canonicalEvents);
  }, [canonicalEvents, lazyHistory, selected, selectedRunId, selectedNode?.executionId]);

  if (tree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-body-2-regular text-text-tertiary text-center">
          No subagents in this conversation yet.
        </p>
      </div>
    );
  }

  // Selection survives live re-derivation because card ids are stable.
  if (selected) {
    const f = fidelityFor(selected, fidelity);
    // A legacy card's id IS its spawn step; a canonical card resolves through the
    // legacy projection's aliases (falling back to its own id when none matches).
    const spawnStepId = legacySpawnStepIdForCanonical(selected, legacy) ?? selected.id;
    return (
      <AgentDetail
        node={selectedNode as ChildTreeNode}
        card={selected}
        fidelity={f}
        steps={steps}
        ownerByStep={ownerByStep}
        spawnStepId={spawnStepId}
        canonicalEvents={detailEvents}
        historyLoading={historyLoading}
        parentThreadId={selectedNode?.productParentThreadId ?? parentThreadId ?? rootRunId ?? ""}
        onBack={() => {
          setSelectedId(null);
          if (focusExecutionId) onClearNativeSessionFocus?.();
        }}
      />
    );
  }

  const focusVisible = (index: number): void => {
    const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-child-tree-id]");
    rows?.[Math.max(0, Math.min(index, (rows.length ?? 1) - 1))]?.focus();
  };

  const handleTreeKey = (item: VisibleChildNode, index: number) =>
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusVisible(index + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusVisible(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusVisible(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusVisible(visible.length - 1);
      } else if (event.key === "ArrowRight" && item.node.childCount > 0) {
        event.preventDefault();
        if (collapsed.has(item.node.id)) {
          setCollapsed((current) => {
            const next = new Set(current);
            next.delete(item.node.id);
            return next;
          });
        } else {
          focusVisible(index + 1);
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (item.node.childCount > 0 && !collapsed.has(item.node.id)) {
          setCollapsed((current) => new Set(current).add(item.node.id));
        } else if (item.parentId) {
          const parentIndex = visible.findIndex(({ node }) => node.id === item.parentId);
          if (parentIndex >= 0) focusVisible(parentIndex);
        }
      }
    };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Child sessions"
      aria-live="polite"
      aria-relevant="additions text"
      className="h-full space-y-2 overflow-y-auto p-3"
      data-testid="agents-rail"
    >
      {visible.map((item, index) => (
        <ChildTreeRow
          key={item.node.id}
          node={item.node}
          onOpen={() => {
            if (item.node.nativeCard || item.node.executionId) setSelectedId(item.node.id);
          }}
          treeItem={{
            id: item.node.id,
            level: item.level,
            position: item.position,
            setSize: item.setSize,
            expanded: item.node.childCount > 0 ? !collapsed.has(item.node.id) : undefined,
            tabIndex: (activeTreeId ?? visible[0]?.node.id) === item.node.id ? 0 : -1,
            onKeyDown: handleTreeKey(item, index),
            onFocus: () => setActiveTreeId(item.node.id),
          }}
        />
      ))}
    </div>
  );
}
