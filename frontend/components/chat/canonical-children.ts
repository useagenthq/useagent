import type { CanonicalEventLike } from "./canonical-timeline";
import type { ChildFidelity, ChildStatus } from "./native-events";
import type { SubagentCard, SubagentModel } from "./subagents";

export interface CanonicalChildModel extends SubagentModel {
  readonly fidelity: ReadonlyMap<string, ChildFidelity>;
}

interface MutableChild {
  readonly card: SubagentCard;
  readonly callId: string;
  status: ChildStatus;
  progress: string | null;
  resultText: string | null;
  recentActivity: { at: string; summary: string }[];
}

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

function timestampOf(event: CanonicalEventLike): number {
  return typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : event.seq;
}

function statusFromUpdate(status: string | undefined, prior: ChildStatus): ChildStatus {
  const normalized = status?.trim().toLowerCase();
  return normalized && KNOWN_STATUSES.has(normalized as ChildStatus)
    ? (normalized as ChildStatus)
    : prior;
}

function fidelityOf(child: MutableChild): ChildFidelity {
  return {
    callId: child.callId,
    childSessionId: child.card.childSessionId,
    status: child.status,
    resultText: child.resultText,
    progress: child.progress,
    lastToolName: null,
    recentActivity: child.recentActivity,
    usage: null,
  };
}

/**
 * Fold provider-neutral child lifecycle events into the existing Agents-rail
 * card and fidelity shapes. A card exists only after a durable child.started
 * event establishes its identity; orphan updates/completions are ignored rather
 * than guessed from display order or parent liveness.
 */
export function deriveCanonicalChildren(
  events: readonly CanonicalEventLike[],
): CanonicalChildModel {
  const children = new Map<string, MutableChild>();

  for (const event of events.toSorted((a, b) => a.seq - b.seq)) {
    const childId = event.childId;
    if (!childId) continue;

    if (event.kind === "child.started") {
      if (children.has(childId)) continue;
      const callId = event.launchToolCallId ?? childId;
      const startedAt = timestampOf(event);
      children.set(childId, {
        callId,
        status: "running",
        progress: null,
        resultText: null,
        recentActivity: [],
        card: {
          id: `canonical-child-${childId}`,
          title: event.title?.trim() || "Subagent",
          childSessionId: childId,
          callId,
          aliases: [...new Set([callId, childId])],
          status: null,
          startedAt,
          lastActivityAt: startedAt,
        },
      });
      continue;
    }

    const child = children.get(childId);
    if (!child) continue;
    const at = timestampOf(event);

    if (event.kind === "child.updated") {
      const progress = event.status?.trim() || null;
      child.status = statusFromUpdate(progress ?? undefined, child.status);
      child.progress = progress;
      child.card.status = progress;
      child.card.lastActivityAt = at;
      if (progress) {
        child.recentActivity.push({ at: new Date(at).toISOString(), summary: progress });
      }
      continue;
    }

    if (event.kind === "child.completed") {
      child.status = event.status === "error" ? "failed" : "completed";
      child.resultText = event.result?.trim() || null;
      child.card.lastActivityAt = at;
    }
  }

  const cards = [...children.values()].map(({ card }) => card);
  const fidelity = new Map<string, ChildFidelity>();
  for (const child of children.values()) {
    const value = fidelityOf(child);
    for (const alias of child.card.aliases) fidelity.set(alias, value);
  }

  return { cards, ownerByStep: new Map(), fidelity };
}
