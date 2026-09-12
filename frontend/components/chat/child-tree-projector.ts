import type { MergedChildFidelity } from "./canonical-children";
import type { CanonicalEventLike } from "./canonical-timeline";
import type {
  ExecutionGraphResponse,
  ExecutionGraphRow,
} from "./execution-graph-client";
import type { GatewayChildSession } from "./gateway-children";
import type { ChildStatus } from "./native-events";
import type { SubagentCard } from "./subagents";
import type { ThreadRelationship } from "@useagent/agent-client";

export type ChildLane = "product" | "native" | "gateway";

export interface ChildControlAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface ChildTreeControls {
  readonly resume: ChildControlAvailability;
  readonly cancel: ChildControlAvailability;
  readonly steer: ChildControlAvailability;
}

export interface ChildTreeNode {
  readonly id: string;
  readonly lane: ChildLane;
  readonly title: string;
  readonly prompt: string | null;
  readonly provider: string | null;
  readonly engine: GatewayChildSession["engine"] | null;
  readonly model: string | null;
  readonly role: string | null;
  readonly progress: string | null;
  readonly result: string | null;
  readonly lastToolName: string | null;
  readonly status: ChildStatus;
  readonly usage: MergedChildFidelity["usage"];
  readonly elapsedMs: number | null;
  readonly aliases: readonly string[];
  readonly nativeCard: SubagentCard | null;
  readonly gatewayChild: GatewayChildSession | null;
  readonly productRelationship: ThreadRelationship | null;
  readonly executionId: string | null;
  readonly executionRunId: string | null;
  readonly productParentThreadId: string | null;
  readonly controls: ChildTreeControls;
  readonly children: readonly ChildTreeNode[];
  readonly childCount: number;
}

interface FlatChildTreeNode extends Omit<ChildTreeNode, "children" | "childCount"> {
  readonly parentId: string | null;
  readonly order: number;
}

export interface ProjectChildTreeInput {
  readonly cards: readonly SubagentCard[];
  readonly fidelity: ReadonlyMap<string, MergedChildFidelity>;
  readonly gatewayChildren: readonly GatewayChildSession[];
  readonly productChildren?: readonly ThreadRelationship[];
  /** Execution graphs fetched through each product child's exact latest run.
   * Native roots in these graphs are attached beneath that product thread only. */
  readonly productGraphs?: ReadonlyMap<string, ExecutionGraphResponse>;
  readonly graph?: ExecutionGraphResponse | null;
  readonly delegationEdges?: readonly { readonly parentId: string; readonly childId: string }[];
  readonly canonicalEvents?: readonly CanonicalEventLike[];
  readonly runLive: boolean;
}

const ACTIVE = new Set<ChildStatus>(["pending", "running", "waiting"]);
const KNOWN_STATUSES = new Set<ChildStatus>([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function nativeStatus(value: string | undefined, runLive: boolean): ChildStatus {
  const status = value?.trim().toLowerCase();
  if (status === "queued") return "pending";
  if (status === "in_progress") return "running";
  return status && KNOWN_STATUSES.has(status as ChildStatus)
    ? (status as ChildStatus)
    : runLive
      ? "running"
      : "completed";
}

function durableExecutionStatus(value: string | undefined): ChildStatus | null {
  const status = value?.trim().toLowerCase();
  if (status === "queued") return "pending";
  if (status === "in_progress") return "running";
  return status && KNOWN_STATUSES.has(status as ChildStatus) ? (status as ChildStatus) : null;
}

function fidelityFor(
  card: SubagentCard,
  fidelity: ReadonlyMap<string, MergedChildFidelity>,
): MergedChildFidelity | undefined {
  for (const alias of [card.childSessionId, ...card.aliases]) {
    if (!alias) continue;
    const match = fidelity.get(alias);
    if (match) return match;
  }
  return undefined;
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsed(execution: ExecutionGraphRow | undefined): number | null {
  const start = time(execution?.started_at);
  const end = time(execution?.settled_at);
  return start !== null && end !== null && end > start ? end - start : null;
}

function sessionCapabilities(
  events: readonly CanonicalEventLike[],
  nativeSessionId: string | null,
): Readonly<Record<string, boolean>> | null {
  if (!nativeSessionId) return null;
  let latest: CanonicalEventLike | null = null;
  for (const event of events) {
    if (
      event.kind === "session.started" &&
      event.identity?.nativeSessionId === nativeSessionId &&
      (!latest || event.seq >= latest.seq)
    ) latest = event;
  }
  return latest?.capabilities ?? null;
}

function unavailable(reason: string): ChildControlAvailability {
  return { available: false, reason };
}

/** Child controls are descriptive until a child-targeted command route exists.
 * Negotiated provider support is never promoted into a fake product action. */
export function projectChildControls(input: {
  readonly lane: ChildLane;
  readonly status: ChildStatus;
  readonly resumable: boolean | null;
  readonly capabilities: Readonly<Record<string, boolean>> | null;
}): ChildTreeControls {
  if (input.lane === "product") {
    return {
      resume: { available: true, reason: null },
      cancel: unavailable("Open the child session to stop its active run."),
      steer: { available: true, reason: null },
    };
  }
  if (input.lane === "gateway") {
    return {
      resume: { available: true, reason: null },
      cancel: unavailable("Open the child session to stop its run."),
      steer: unavailable("Open the child session to continue with a new turn."),
    };
  }

  const resumeReason = input.resumable === false
    ? "This child is not resumable."
    : input.capabilities?.resume !== true
      ? "This provider did not negotiate resume for this child session."
      : "Resume is negotiated, but no child-targeted resume route is available.";
  const cancelReason = input.capabilities?.stop !== true
    ? "This provider did not negotiate cancel for this child session."
    : ACTIVE.has(input.status)
      ? "Provider cancel applies to the parent run; child-targeted cancel is unavailable."
      : "This child is no longer running.";
  const steerReason = input.capabilities?.steer !== true
    ? "This provider did not negotiate child steering."
    : "Steering is negotiated, but no child-targeted steer route is available.";
  return {
    resume: unavailable(resumeReason),
    cancel: unavailable(cancelReason),
    steer: unavailable(steerReason),
  };
}

function aliasesForExecution(execution: ExecutionGraphRow): string[] {
  return [execution.id, execution.native_session_id].filter(
    (value): value is string => Boolean(value),
  );
}

function firstAliasMatch<T>(aliases: readonly string[], values: ReadonlyMap<string, T>): T | undefined {
  for (const alias of aliases) {
    const value = values.get(alias);
    if (value) return value;
  }
  return undefined;
}

function wouldCycle(
  id: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set([id]);
  let cursor = parentId;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

/** Deterministic, transcript-free projection for the Agents workspace. */
export function projectChildTree(input: ProjectChildTreeInput): ChildTreeNode[] {
  const graphExecutions = [
    ...(input.graph?.executions ?? []),
    ...[...(input.productGraphs ?? new Map())].flatMap(([, graph]) => graph.executions),
  ];
  const graphEdges = [
    ...(input.graph?.delegationEdges ?? []),
    ...[...(input.productGraphs ?? new Map())].flatMap(([, graph]) => graph.delegationEdges ?? []),
  ];
  const productOwnerByExecutionId = new Map<string, { threadId: string; runId: string }>();
  const productByThreadId = new Map(
    (input.productChildren ?? []).map((child) => [child.threadId, child] as const),
  );
  for (const [threadId, graph] of input.productGraphs ?? []) {
    const relationship = productByThreadId.get(threadId);
    if (!relationship) continue;
    for (const execution of graph.executions) {
      productOwnerByExecutionId.set(execution.id, {
        threadId,
        runId: relationship.latestRunId,
      });
    }
  }
  const cardByAlias = new Map<string, SubagentCard>();
  for (const card of input.cards) {
    for (const alias of [card.id, card.childSessionId, ...card.aliases]) {
      if (alias) cardByAlias.set(alias, card);
    }
  }
  const gatewayIds = new Set(input.gatewayChildren.map((child) => child.id));
  const flat = new Map<string, FlatChildTreeNode>();
  const nodeByAlias = new Map<string, string>();

  const productIds = new Set((input.productChildren ?? []).map((child) => child.threadId));
  for (const [index, child] of (input.productChildren ?? []).entries()) {
    const id = `product:${child.threadId}`;
    const aliases = [child.threadId, child.latestRunId]
      .filter((value): value is string => Boolean(value));
    flat.set(id, {
      id,
      lane: "product",
      title: child.title,
      prompt: null,
      provider: null,
      engine: child.engine,
      model: child.model,
      role: "Product child",
      progress: null,
      result: null,
      lastToolName: null,
      status: nativeStatus(child.status, false),
      usage: null,
      elapsedMs: null,
      aliases,
      nativeCard: null,
      gatewayChild: null,
      productRelationship: child,
      executionId: null,
      executionRunId: child.latestRunId,
      productParentThreadId: child.parentThreadId,
      controls: projectChildControls({
        lane: "product",
        status: nativeStatus(child.status, false),
        resumable: true,
        capabilities: null,
      }),
      parentId: child.parentThreadId && productIds.has(child.parentThreadId)
        ? `product:${child.parentThreadId}`
        : null,
      order: time(child.createdAt) ?? index,
    });
    for (const alias of aliases) nodeByAlias.set(alias, id);
  }

  const nativeExecutions = graphExecutions.filter((execution) => execution.mode === "native_child");
  const representedCards = new Set<SubagentCard>();
  for (const [index, execution] of nativeExecutions.entries()) {
    const aliases = aliasesForExecution(execution);
    const productOwner = productOwnerByExecutionId.get(execution.id) ?? null;
    const card = productOwner ? undefined : firstAliasMatch(aliases, cardByAlias);
    if (card?.aliases.some((alias) => gatewayIds.has(alias))) continue;
    if (execution.native_session_id && gatewayIds.has(execution.native_session_id)) continue;
    if (card) representedCards.add(card);
    const fidelity = card ? fidelityFor(card, input.fidelity) : undefined;
    const id = `native:${execution.id}`;
    const allAliases = [...new Set([...aliases, ...(card?.aliases ?? []), card?.id].filter(Boolean))] as string[];
    // The execution graph is durable run truth. Canonical/native fidelity fills
    // detail, but must not keep a settled execution looking like it is Working.
    const status = durableExecutionStatus(execution.status)
      ?? fidelity?.status
      ?? nativeStatus(undefined, input.runLive);
    const nativeSessionId = execution.native_session_id ?? card?.childSessionId ?? null;
    flat.set(id, {
      id,
      lane: "native",
      title: card?.title ?? fidelity?.prompt?.split("\n", 1)[0]?.trim() ?? fidelity?.role ?? `${execution.provider} child`,
      prompt: fidelity?.prompt ?? null,
      provider: execution.provider,
      engine: null,
      model: fidelity?.model ?? null,
      role: fidelity?.role ?? null,
      progress: ACTIVE.has(status) ? fidelity?.progress ?? null : null,
      result: fidelity?.resultText ?? null,
      lastToolName: fidelity?.lastToolName ?? null,
      status,
      usage: fidelity?.usage ?? null,
      elapsedMs: fidelity?.usage?.durationMs ?? elapsed(execution),
      aliases: allAliases,
      nativeCard: card ?? null,
      gatewayChild: null,
      productRelationship: null,
      executionId: execution.id,
      executionRunId: productOwner?.runId ?? null,
      productParentThreadId: productOwner?.threadId ?? null,
      controls: projectChildControls({
        lane: "native",
        status,
        resumable: fidelity?.resumable ?? null,
        capabilities: sessionCapabilities(input.canonicalEvents ?? [], nativeSessionId),
      }),
      parentId: productOwner ? `product:${productOwner.threadId}` : null,
      order: time(execution.created_at) ?? index,
    });
    for (const alias of allAliases) nodeByAlias.set(alias, id);
  }

  for (const [index, card] of input.cards.entries()) {
    if (
      representedCards.has(card) ||
      card.aliases.some((alias) => gatewayIds.has(alias))
    ) continue;
    const fidelity = fidelityFor(card, input.fidelity);
    const id = `native:${card.id}`;
    const aliases = [...new Set([card.id, card.childSessionId, ...card.aliases].filter(Boolean))] as string[];
    const status = fidelity?.status ?? nativeStatus(undefined, input.runLive);
    flat.set(id, {
      id,
      lane: "native",
      title: card.title,
      prompt: fidelity?.prompt ?? null,
      provider: null,
      engine: null,
      model: fidelity?.model ?? null,
      role: fidelity?.role ?? null,
      progress: fidelity?.progress ?? null,
      result: fidelity?.resultText ?? null,
      lastToolName: fidelity?.lastToolName ?? null,
      status,
      usage: fidelity?.usage ?? null,
      elapsedMs: fidelity?.usage?.durationMs ?? null,
      aliases,
      nativeCard: card,
      gatewayChild: null,
      productRelationship: null,
      executionId: null,
      executionRunId: null,
      productParentThreadId: null,
      controls: projectChildControls({
        lane: "native",
        status,
        resumable: fidelity?.resumable ?? null,
        capabilities: sessionCapabilities(input.canonicalEvents ?? [], card.childSessionId),
      }),
      parentId: null,
      order: card.startedAt || nativeExecutions.length + index,
    });
    for (const alias of aliases) nodeByAlias.set(alias, id);
  }

  for (const [index, child] of input.gatewayChildren.entries()) {
    const id = `gateway:${child.id}`;
    const status = nativeStatus(child.status, false);
    flat.set(id, {
      id,
      lane: "gateway",
      title: child.prompt,
      prompt: child.prompt,
      provider: null,
      engine: child.engine,
      model: child.model,
      role: null,
      progress: null,
      result: child.summary,
      lastToolName: null,
      status,
      usage: null,
      elapsedMs: child.durationMs ?? null,
      aliases: [child.id],
      nativeCard: null,
      gatewayChild: child,
      productRelationship: null,
      executionId: null,
      executionRunId: null,
      productParentThreadId: null,
      controls: projectChildControls({
        lane: "gateway",
        status,
        resumable: true,
        capabilities: null,
      }),
      parentId: child.parentRunId && gatewayIds.has(child.parentRunId)
        ? `gateway:${child.parentRunId}`
        : null,
      order: time(child.createdAt) ?? Number.MAX_SAFE_INTEGER / 2 + index,
    });
    nodeByAlias.set(child.id, id);
  }

  const parents = new Map<string, string | null>([...flat].map(([id, node]) => [id, node.parentId]));
  for (const edge of graphEdges) {
    if (!edge.child_execution_id) continue;
    const childId = nodeByAlias.get(edge.child_execution_id);
    const parentId = edge.parent_execution_id ? nodeByAlias.get(edge.parent_execution_id) : undefined;
    if (childId && parentId && childId !== parentId) parents.set(childId, parentId);
  }
  for (const execution of nativeExecutions) {
    const childId = nodeByAlias.get(execution.id);
    const parentId = execution.native_parent_session_id
      ? nodeByAlias.get(execution.native_parent_session_id)
      : undefined;
    if (childId && parentId && childId !== parentId && !parents.get(childId)) {
      parents.set(childId, parentId);
    }
  }
  for (const edge of input.delegationEdges ?? []) {
    const childId = nodeByAlias.get(edge.childId);
    const parentId = nodeByAlias.get(edge.parentId);
    if (childId && parentId && childId !== parentId && !parents.get(childId)) {
      parents.set(childId, parentId);
    }
  }

  const childrenByParent = new Map<string | null, FlatChildTreeNode[]>();
  for (const [id, node] of flat) {
    const candidate = parents.get(id) ?? null;
    const parentId = candidate && flat.has(candidate) && !wouldCycle(id, candidate, parents)
      ? candidate
      : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push({ ...node, parentId });
    childrenByParent.set(parentId, siblings);
  }
  const compare = (a: FlatChildTreeNode, b: FlatChildTreeNode): number =>
    a.order - b.order || a.id.localeCompare(b.id);
  for (const siblings of childrenByParent.values()) siblings.sort(compare);

  const build = (node: FlatChildTreeNode): ChildTreeNode => {
    const children = (childrenByParent.get(node.id) ?? []).map(build);
    const { parentId: _parentId, order: _order, ...rest } = node;
    return { ...rest, children, childCount: children.length };
  };
  return (childrenByParent.get(null) ?? []).map(build);
}
