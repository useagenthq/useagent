"use client";


import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionSummarySnapshot } from "@useagent/agent-client";
import {
  legacySpawnStepIdForCanonical,
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
import type { NativeFrame } from "@/components/chat/native-events";
import { ProductChildDetail } from "@/components/chat/product-child-detail";
import type { SubagentCard } from "@/components/chat/subagents";
import type { ThreadRelationship } from "@useagent/agent-client";
import { type ApiStep } from "@/components/chat/types";
import { useProductChildGraphs } from "@/components/chat/use-product-child-graphs";
import { formatDuration } from "@/utils/format";
import type { ChildKind } from "@/components/chat/child-labels";
import {
  AgentPanelRow,
} from "@/components/session-ui/agent-panel-row";
import {
  childElapsedMs,
  childStatusLabel,
  isChildActive,
  type RailChildFidelity,
  useNow,
} from "@/components/chat/agent-status";
import { AgentDetail } from "@/components/chat/agent-detail";
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
  const kind: ChildKind = node.lane === "product"
    ? node.productRelationship?.bot ? "bot_thread" : "child_thread"
    : node.lane === "gateway" ? "spawned_session" : "subagent";

  return (
    <AgentPanelRow
      href={node.productRelationship
        ? undefined
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
        kind,
        botName: node.productRelationship?.bot?.name ?? null,
      }}
      onOpen={onOpen}
      treeItem={treeItem}
    />
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
  focusProductThreadId = null,
  focusExecutionId = null,
  focusExecutionRunId = null,
  onClearProductFocus,
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
  /** Product child selected from the parent conversation. */
  focusProductThreadId?: string | null;
  onClearProductFocus?: () => void;
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
  const appliedProductFocusRef = useRef<string | null>(null);
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
  const focusProductNodeId = focusProductThreadId
    ? `product:${focusProductThreadId}`
    : null;
  useEffect(() => {
    if (!focusProductThreadId) {
      if (appliedProductFocusRef.current !== null) {
        appliedProductFocusRef.current = null;
        setSelectedId(null);
      }
      return;
    }
    if (
      !focusProductNodeId ||
      !allNodes.has(focusProductNodeId) ||
      appliedProductFocusRef.current === focusProductThreadId
    ) return;
    appliedProductFocusRef.current = focusProductThreadId;
    setSelectedId(focusProductNodeId);
  }, [allNodes, focusProductNodeId, focusProductThreadId]);
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

  if (selectedNode?.productRelationship) {
    return (
      <ProductChildDetail
        relationship={selectedNode.productRelationship}
        onBack={() => {
          setSelectedId(null);
          if (focusProductThreadId) onClearProductFocus?.();
        }}
      />
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
            if (item.node.productRelationship || item.node.nativeCard || item.node.executionId) {
              setSelectedId(item.node.id);
            }
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
