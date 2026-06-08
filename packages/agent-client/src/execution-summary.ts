import type { CanonicalChildUsage } from "@useagent/agent-harness/canonical";
import type { CanonicalThreadEvent } from "./thread-events";

export interface ExecutionSummaryIdentity {
  readonly provider: string;
  /** Present only when canonical evidence identifies the child id as a native session. */
  readonly nativeSessionId: string | null;
  readonly nativeParentSessionId: string | null;
}

export interface ExecutionSummary {
  readonly id: string;
  readonly parentId: string | null;
  readonly aliases: readonly string[];
  readonly identity: ExecutionSummaryIdentity;
  readonly runId: string;
  readonly startedSeq: number;
  readonly startedAt: number;
  readonly lastActivitySeq: number;
  readonly lastActivityAt: number;
  readonly title: string | null;
  readonly prompt: string | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly lastToolName: string | null;
  readonly lastToolStatus: string | null;
  readonly lastMessagePreview: string | null;
  readonly result: string | null;
  readonly usage: CanonicalChildUsage | null;
  readonly resumable: boolean | null;
}

export interface ExecutionSummarySnapshot {
  readonly version: 1;
  readonly children: readonly ExecutionSummary[];
  readonly delegationEdges: readonly { parentId: string; childId: string }[];
}

export interface ExecutionSummaryRetention {
  /** Thread bound on first ingest (or explicitly at construction). */
  readonly threadId: string | null;
  readonly acceptedEvents: number;
  readonly children: number;
  readonly pendingChildren: number;
  readonly pendingContributions: number;
  readonly slotContributions: number;
  readonly compactedThrough: number;
}

export interface ExecutionSummaryProjector {
  ingest(event: CanonicalThreadEvent): boolean;
  snapshot(): ExecutionSummarySnapshot;
  /**
   * Drop replay bookkeeping through a durable delivery cursor. Callers must only
   * advance this after their source guarantees those delivery sequences cannot
   * be revised or replayed as new truth. Current winners remain as compact
   * per-child state; orphan contributions before the cursor are discarded.
   */
  compactThrough(deliverySeq: number): ExecutionSummaryRetention;
  retention(): ExecutionSummaryRetention;
}

export interface ExecutionSummaryProjectorOptions {
  /**
   * Optional thread guard. The canonical delivery sequence is thread-scoped, so
   * one projector must never combine events from different threads.
   */
  readonly threadId?: string;
}

type SummarySlot = Exclude<keyof ExecutionSummary, "id" | "identity">
  | "provider"
  | "nativeSessionId"
  | "nativeParentSessionId";

interface RankedValue {
  readonly eventId: string;
  readonly deliverySeq: number;
  readonly revision: number;
  readonly value: unknown;
}

interface CompactContribution {
  readonly childId: string;
  readonly slot: SummarySlot;
  readonly ranked: RankedValue;
}

interface AcceptedEvent {
  readonly revision: number;
  readonly deliverySeq: number;
  readonly childId: string | null;
  readonly contributions: readonly CompactContribution[];
}

interface MutableChild {
  readonly slots: Map<SummarySlot, Map<string, RankedValue>>;
  readonly winners: Map<SummarySlot, RankedValue>;
}

const PREVIEW_LIMIT = 160;

function preview(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= PREVIEW_LIMIT ? value : value.slice(0, PREVIEW_LIMIT);
}

function supersedes(
  next: Pick<CanonicalThreadEvent, "revision" | "deliverySeq">,
  previous: Pick<CanonicalThreadEvent, "revision" | "deliverySeq"> | undefined,
): boolean {
  return previous === undefined
    || next.revision > previous.revision
    || (next.revision === previous.revision && next.deliverySeq > previous.deliverySeq);
}

function later(a: RankedValue, b: RankedValue | undefined): boolean {
  if (!b) return true;
  if (a.deliverySeq !== b.deliverySeq) return a.deliverySeq > b.deliverySeq;
  if (a.revision !== b.revision) return a.revision > b.revision;
  return a.eventId > b.eventId;
}

function lifecycleChildId(event: CanonicalThreadEvent): string | null {
  return event.kind === "child.started"
    || event.kind === "child.updated"
    || event.kind === "child.completed"
    ? event.childId
    : null;
}

function aliases(childId: string, launchToolCallId: string | undefined): readonly string[] {
  return launchToolCallId && launchToolCallId !== childId
    ? [childId, launchToolCallId]
    : [childId];
}

function compactContributions(event: CanonicalThreadEvent): CompactContribution[] {
  const childId = lifecycleChildId(event) ?? event.identity.nativeSessionId;
  if (!childId) return [];
  const ranked = (slot: SummarySlot, value: unknown): CompactContribution => ({
    childId,
    slot,
    ranked: {
      eventId: event.eventId,
      deliverySeq: event.deliverySeq,
      revision: event.revision,
      value,
    },
  });
  const state = "state" in event ? event.state : undefined;
  const lifecycleContributions = lifecycleChildId(event) === null
    ? []
    : [
      ranked("runId", event.runId),
      ranked("lastActivitySeq", event.seq),
      ranked("lastActivityAt", event.ts),
    ];
  const identityContributions = event.identity.nativeSessionId === childId
    ? [
      ranked("nativeSessionId", childId),
      ...(event.identity.nativeParentSessionId !== undefined
        ? [ranked("nativeParentSessionId", event.identity.nativeParentSessionId)]
        : []),
    ]
    : [];
  const stateContributions = (): CompactContribution[] => [
    ...(state?.prompt !== undefined ? [ranked("prompt", state.prompt)] : []),
    ...(state?.role !== undefined ? [ranked("role", state.role)] : []),
    ...(state?.model !== undefined ? [ranked("model", state.model)] : []),
    ...(state?.usage !== undefined ? [ranked("usage", state.usage)] : []),
    ...(state?.resumable !== undefined ? [ranked("resumable", state.resumable)] : []),
    ...(state?.summary !== undefined ? [ranked("summary", state.summary)] : []),
    ...(state?.lastToolName !== undefined ? [ranked("lastToolName", state.lastToolName)] : []),
  ];

  switch (event.kind) {
    case "child.started":
      return [
        ranked("provider", event.identity.provider),
        ranked(
          "parentId",
          event.parentChildId
            ?? event.identity.nativeParentSessionId
            ?? (event.identity.nativeSessionId !== event.childId
              ? event.identity.nativeSessionId
              : undefined)
            ?? event.runId,
        ),
        ranked("aliases", aliases(event.childId, event.launchToolCallId)),
        ranked("title", event.title ?? null),
        ranked("status", event.state?.status ?? "running"),
        ranked("startedSeq", event.seq),
        ranked("startedAt", event.ts),
        ...lifecycleContributions,
        ...identityContributions,
        ...stateContributions(),
      ];
    case "child.updated":
      return [
        ranked("provider", event.identity.provider),
        ranked("status", event.state?.status ?? event.status),
        ...lifecycleContributions,
        ...identityContributions,
        ...stateContributions(),
      ];
    case "child.completed":
      return [
        ranked("provider", event.identity.provider),
        ranked("status", event.status),
        ranked("result", preview(event.result)),
        ...lifecycleContributions,
        ...identityContributions,
        ...stateContributions(),
      ];
    case "tool.started":
      return [
        ...identityContributions,
        ranked("lastToolName", event.name),
        ranked("lastToolStatus", "running"),
      ];
    case "tool.progress":
      return [...identityContributions, ranked("lastToolStatus", "running")];
    case "tool.completed":
      return [...identityContributions, ranked("lastToolStatus", event.status)];
    case "message.delta":
    case "message.completed":
      return [...identityContributions, ranked("lastMessagePreview", preview(event.text))];
    default:
      return [];
  }
}

function emptyChild(): MutableChild {
  return { slots: new Map(), winners: new Map() };
}

function resolveWinner(values: ReadonlyMap<string, RankedValue>): RankedValue | undefined {
  let winner: RankedValue | undefined;
  for (const value of values.values()) {
    if (later(value, winner)) winner = value;
  }
  return winner;
}

function value<T>(child: MutableChild, slot: SummarySlot, fallback: T): T {
  return (child.winners.get(slot)?.value as T | undefined) ?? fallback;
}

function stableSnapshot(children: ReadonlyMap<string, MutableChild>): ExecutionSummarySnapshot {
  const summaries = [...children].map(([id, child]): ExecutionSummary => {
    const lastActivitySeq = value(child, "lastActivitySeq", 0);
    const lastActivityAt = value(child, "lastActivityAt", 0);
    return {
      id,
      parentId: value(child, "parentId", null),
      aliases: value(child, "aliases", [id]),
      identity: {
        provider: value(child, "provider", "unknown"),
        nativeSessionId: value(child, "nativeSessionId", null),
        nativeParentSessionId: value(child, "nativeParentSessionId", null),
      },
      runId: value(child, "runId", "unknown"),
      startedSeq: value(child, "startedSeq", lastActivitySeq),
      startedAt: value(child, "startedAt", lastActivityAt),
      lastActivitySeq,
      lastActivityAt,
      title: value(child, "title", null),
      prompt: value(child, "prompt", null),
      role: value(child, "role", null),
      model: value(child, "model", null),
      status: value(child, "status", "running"),
      summary: value(child, "summary", null),
      lastToolName: value(child, "lastToolName", null),
      lastToolStatus: value(child, "lastToolStatus", null),
      lastMessagePreview: value(child, "lastMessagePreview", null),
      result: value(child, "result", null),
      usage: value(child, "usage", null),
      resumable: value(child, "resumable", null),
    };
  }).toSorted((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    children: summaries,
    delegationEdges: summaries
      .filter((child): child is ExecutionSummary & { parentId: string } => child.parentId !== null)
      .map((child) => ({ parentId: child.parentId, childId: child.id }))
      .toSorted((a, b) => a.childId.localeCompare(b.childId)),
  };
}

/**
 * Incremental, transcript-free projection of one canonical thread's child state.
 * The first event binds an unconfigured projector to its thread; cross-thread
 * ingestion throws rather than silently merging colliding child/session ids.
 */
export function createExecutionSummaryProjector(
  options: ExecutionSummaryProjectorOptions = {},
): ExecutionSummaryProjector {
  const accepted = new Map<string, AcceptedEvent>();
  const children = new Map<string, MutableChild>();
  const pending = new Map<string, Map<SummarySlot, Map<string, RankedValue>>>();
  const compactedAnchors = new Set<string>();
  let cached: ExecutionSummarySnapshot | null = null;
  let compactedThrough = 0;
  let threadId = options.threadId ?? null;

  const applyContribution = (contribution: CompactContribution): void => {
    const child = children.get(contribution.childId);
    if (!child) {
      const slots = pending.get(contribution.childId) ?? new Map();
      const values = slots.get(contribution.slot) ?? new Map();
      values.set(contribution.ranked.eventId, contribution.ranked);
      slots.set(contribution.slot, values);
      pending.set(contribution.childId, slots);
      return;
    }
    const values = child.slots.get(contribution.slot) ?? new Map<string, RankedValue>();
    values.set(contribution.ranked.eventId, contribution.ranked);
    child.slots.set(contribution.slot, values);
    const winner = child.winners.get(contribution.slot);
    if (later(contribution.ranked, winner) || winner?.eventId === contribution.ranked.eventId) {
      child.winners.set(contribution.slot, contribution.ranked);
    }
  };

  const ensureChild = (childId: string): MutableChild => {
    const existing = children.get(childId);
    if (existing) return existing;
    const child = emptyChild();
    children.set(childId, child);
    const staged = pending.get(childId);
    if (staged) {
      pending.delete(childId);
      for (const [slot, values] of staged) {
        for (const ranked of values.values()) applyContribution({ childId, slot, ranked });
      }
    }
    return child;
  };

  const hasLifecycleAnchor = (childId: string): boolean => {
    if (compactedAnchors.has(childId)) return true;
    for (const event of accepted.values()) {
      if (event.childId === childId) return true;
    }
    return false;
  };

  const dematerializeChild = (childId: string): void => {
    const child = children.get(childId);
    if (!child) return;
    const staged = pending.get(childId) ?? new Map<SummarySlot, Map<string, RankedValue>>();
    for (const [slot, values] of child.slots) {
      const pendingValues = staged.get(slot) ?? new Map<string, RankedValue>();
      for (const [eventId, ranked] of values) pendingValues.set(eventId, ranked);
      staged.set(slot, pendingValues);
    }
    children.delete(childId);
    if (staged.size > 0) pending.set(childId, staged);
  };

  const removeContribution = (contribution: CompactContribution): void => {
    const child = children.get(contribution.childId);
    if (!child) {
      const slots = pending.get(contribution.childId);
      const values = slots?.get(contribution.slot);
      values?.delete(contribution.ranked.eventId);
      if (values?.size === 0) slots?.delete(contribution.slot);
      if (slots?.size === 0) pending.delete(contribution.childId);
      return;
    }
    const values = child.slots.get(contribution.slot);
    if (!values) return;
    values.delete(contribution.ranked.eventId);
    if (child.winners.get(contribution.slot)?.eventId === contribution.ranked.eventId) {
      const winner = resolveWinner(values);
      if (winner) child.winners.set(contribution.slot, winner);
      else child.winners.delete(contribution.slot);
    }
    if (values.size === 0) child.slots.delete(contribution.slot);
    if (child.slots.size === 0) children.delete(contribution.childId);
  };

  const retention = (): ExecutionSummaryRetention => ({
    threadId,
    acceptedEvents: accepted.size,
    children: children.size,
    pendingChildren: pending.size,
    pendingContributions: [...pending.values()].reduce(
      (total, slots) => total + [...slots.values()].reduce((sum, values) => sum + values.size, 0),
      0,
    ),
    slotContributions: [...children.values()].reduce(
      (total, child) => total + [...child.slots.values()].reduce((sum, values) => sum + values.size, 0),
      0,
    ),
    compactedThrough,
  });

  return {
    ingest(event) {
      if (threadId === null) threadId = event.threadId;
      else if (event.threadId !== threadId) {
        throw new Error(`execution summary projector is bound to thread ${threadId}`);
      }
      if (event.deliverySeq <= compactedThrough) return false;
      const previous = accepted.get(event.eventId);
      if (!supersedes(event, previous)) return false;
      if (previous) {
        for (const contribution of previous.contributions) removeContribution(contribution);
        accepted.delete(event.eventId);
        if (previous.childId && !hasLifecycleAnchor(previous.childId)) {
          dematerializeChild(previous.childId);
        }
      }
      const contributions = compactContributions(event);
      const childId = lifecycleChildId(event);
      accepted.set(event.eventId, {
        revision: event.revision,
        deliverySeq: event.deliverySeq,
        childId,
        contributions,
      });
      if (childId) ensureChild(childId);
      for (const contribution of contributions) applyContribution(contribution);
      cached = null;
      return true;
    },
    snapshot() {
      cached ??= stableSnapshot(children);
      return cached;
    },
    compactThrough(deliverySeq) {
      if (!Number.isSafeInteger(deliverySeq) || deliverySeq < compactedThrough) {
        throw new Error("deliverySeq must be a safe integer at or beyond the compacted cursor");
      }
      compactedThrough = deliverySeq;
      for (const [eventId, event] of accepted) {
        if (event.deliverySeq <= compactedThrough) {
          if (event.childId) compactedAnchors.add(event.childId);
          accepted.delete(eventId);
        }
      }
      for (const [childId, slots] of pending) {
        for (const [slot, values] of slots) {
          for (const [eventId, ranked] of values) {
            if (ranked.deliverySeq <= compactedThrough) values.delete(eventId);
          }
          if (values.size === 0) slots.delete(slot);
        }
        if (slots.size === 0) pending.delete(childId);
      }
      for (const child of children.values()) {
        for (const [slot, values] of child.slots) {
          const winnerId = child.winners.get(slot)?.eventId;
          for (const [eventId, ranked] of values) {
            if (eventId !== winnerId && ranked.deliverySeq <= compactedThrough) values.delete(eventId);
          }
          if (values.size === 0) child.slots.delete(slot);
        }
      }
      return retention();
    },
    retention,
  };
}

export function executionSummaryBytes(snapshot: ExecutionSummarySnapshot): string {
  return JSON.stringify(snapshot);
}
