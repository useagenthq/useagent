import type {
  CanonicalThreadEvent,
  ExecutionSummary,
  ExecutionSummarySnapshot,
} from "@useagent/agent-client";

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

interface Contribution {
  readonly childId: string;
  readonly slot: SummarySlot;
  readonly ranked: RankedValue;
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

function contributions(event: CanonicalThreadEvent): Contribution[] {
  const childId = lifecycleChildId(event) ?? event.identity.nativeSessionId;
  if (!childId) return [];
  const ranked = (slot: SummarySlot, value: unknown): Contribution => ({
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
  const stateContributions = (): Contribution[] => [
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
        ranked(
          "aliases",
          event.launchToolCallId && event.launchToolCallId !== event.childId
            ? [event.childId, event.launchToolCallId]
            : [event.childId],
        ),
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

function slotValue<T>(
  winners: ReadonlyMap<SummarySlot, RankedValue>,
  slot: SummarySlot,
  fallback: T,
): T {
  return (winners.get(slot)?.value as T | undefined) ?? fallback;
}

/**
 * Deliberately expensive reference model: retain/dedupe full canonical history,
 * then rebuild the complete summary. It shares only the public snapshot contract
 * with the incremental production projector.
 */
export function recomputeExecutionSummary(
  history: readonly CanonicalThreadEvent[],
): ExecutionSummarySnapshot {
  const threadIds = new Set(history.map((event) => event.threadId));
  if (threadIds.size > 1) throw new Error("execution summary history must contain one thread");

  const accepted = new Map<string, CanonicalThreadEvent>();
  for (const event of history) {
    if (supersedes(event, accepted.get(event.eventId))) accepted.set(event.eventId, event);
  }

  const childIds = new Set<string>();
  for (const event of accepted.values()) {
    const childId = lifecycleChildId(event);
    if (childId) childIds.add(childId);
  }

  const winnersByChild = new Map<string, Map<SummarySlot, RankedValue>>(
    [...childIds].map((childId) => [childId, new Map()]),
  );
  for (const event of accepted.values()) {
    for (const contribution of contributions(event)) {
      const winners = winnersByChild.get(contribution.childId);
      if (!winners) continue;
      if (later(contribution.ranked, winners.get(contribution.slot))) {
        winners.set(contribution.slot, contribution.ranked);
      }
    }
  }

  const children = [...winnersByChild].map(([id, winners]): ExecutionSummary => {
    const lastActivitySeq = slotValue(winners, "lastActivitySeq", 0);
    const lastActivityAt = slotValue(winners, "lastActivityAt", 0);
    return {
      id,
      parentId: slotValue(winners, "parentId", null),
      aliases: slotValue(winners, "aliases", [id]),
      identity: {
        provider: slotValue(winners, "provider", "unknown"),
        nativeSessionId: slotValue(winners, "nativeSessionId", null),
        nativeParentSessionId: slotValue(winners, "nativeParentSessionId", null),
      },
      runId: slotValue(winners, "runId", "unknown"),
      startedSeq: slotValue(winners, "startedSeq", lastActivitySeq),
      startedAt: slotValue(winners, "startedAt", lastActivityAt),
      lastActivitySeq,
      lastActivityAt,
      title: slotValue(winners, "title", null),
      prompt: slotValue(winners, "prompt", null),
      role: slotValue(winners, "role", null),
      model: slotValue(winners, "model", null),
      status: slotValue(winners, "status", "running"),
      summary: slotValue(winners, "summary", null),
      lastToolName: slotValue(winners, "lastToolName", null),
      lastToolStatus: slotValue(winners, "lastToolStatus", null),
      lastMessagePreview: slotValue(winners, "lastMessagePreview", null),
      result: slotValue(winners, "result", null),
      usage: slotValue(winners, "usage", null),
      resumable: slotValue(winners, "resumable", null),
    };
  }).toSorted((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    children,
    delegationEdges: children
      .filter((child): child is ExecutionSummary & { parentId: string } => child.parentId !== null)
      .map((child) => ({ parentId: child.parentId, childId: child.id }))
      .toSorted((a, b) => a.childId.localeCompare(b.childId)),
  };
}

export function executionSummaryBytes(snapshot: ExecutionSummarySnapshot): string {
  return JSON.stringify(snapshot);
}
