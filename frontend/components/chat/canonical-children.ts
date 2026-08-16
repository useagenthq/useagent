import type { CanonicalChildState } from "@skynet/agent-harness/canonical";
import type { CanonicalEventLike } from "./canonical-timeline";
import { type ChildUsage, mergeChildUsage, normalizeChildUsage } from "./child-usage";
import type { ChildFidelity, ChildStatus } from "./native-events";
import type { SubagentCard, SubagentModel } from "./subagents";

export type CanonicalChildStateLike = Readonly<CanonicalChildState>;

export type CanonicalChildEventLike = CanonicalEventLike & {
  readonly state?: CanonicalChildStateLike;
};

export interface CanonicalChildFidelity extends ChildFidelity {
  readonly model: string | null;
  readonly role: string | null;
  readonly resumable: boolean | null;
}

export interface CanonicalChildModel extends SubagentModel {
  readonly fidelity: ReadonlyMap<string, CanonicalChildFidelity>;
}

interface MutableChild {
  readonly card: SubagentCard;
  readonly callId: string;
  status: ChildStatus;
  progress: string | null;
  resultText: string | null;
  recentActivity: { at: string; summary: string }[];
  lastToolName: string | null;
  usage: ChildUsage | null;
  model: string | null;
  role: string | null;
  resumable: boolean | null;
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

function statusFromCompletion(status: string | undefined): ChildStatus {
  return status === "error" ? "failed" : "completed";
}

function appendActivity(
  entries: readonly { at: string; summary: string }[],
  at: number,
  summary: string | null,
): { at: string; summary: string }[] {
  if (!summary || entries.at(-1)?.summary === summary) return [...entries];
  return [...entries, { at: new Date(at).toISOString(), summary }].slice(-8);
}

function applyState(child: MutableChild, state: CanonicalChildStateLike | undefined): void {
  if (!state) return;
  child.status = statusFromUpdate(state.status, child.status);
  child.lastToolName = state.lastToolName?.trim() || child.lastToolName;
  child.usage = mergeChildUsage(child.usage, normalizeChildUsage(state.usage));
  child.model = state.model?.trim() || child.model;
  child.role = state.role?.trim() || child.role;
  if (typeof state.resumable === "boolean") child.resumable = state.resumable;
}

function childFromEvent(
  event: CanonicalChildEventLike,
  childId: string,
  initialStatus: ChildStatus,
  cardStatus: string | null,
): MutableChild {
  const callId = event.launchToolCallId ?? childId;
  const startedAt = timestampOf(event);
  const summary = event.state?.summary?.trim() || null;
  const child: MutableChild = {
    callId,
    status: initialStatus,
    progress: summary,
    resultText: null,
    recentActivity: appendActivity([], startedAt, summary),
    lastToolName: null,
    usage: null,
    model: null,
    role: null,
    resumable: null,
    card: {
      id: `canonical-child-${childId}`,
      title: event.title?.trim() || event.state?.role?.trim() || "Subagent",
      childSessionId: childId,
      callId,
      aliases: [...new Set([callId, childId])],
      status: cardStatus,
      startedAt,
      lastActivityAt: startedAt,
    },
  };
  applyState(child, event.state);
  return child;
}

function fidelityOf(child: MutableChild): CanonicalChildFidelity {
  return {
    callId: child.callId,
    childSessionId: child.card.childSessionId,
    status: child.status,
    resultText: child.resultText,
    progress: child.progress,
    lastToolName: child.lastToolName,
    recentActivity: child.recentActivity,
    usage: child.usage,
    model: child.model,
    role: child.role,
    resumable: child.resumable,
  };
}

/**
 * Fold provider-neutral child lifecycle events into the existing Agents-rail
 * card and fidelity shapes. A card normally starts at child.started; a terminal
 * child.completed can also synthesize the card from its own durable child id so
 * late provider completions retain fidelity without display-order guesses.
 */
export function deriveCanonicalChildren(
  events: readonly CanonicalChildEventLike[],
): CanonicalChildModel {
  const children = new Map<string, MutableChild>();

  for (const event of events.toSorted((a, b) => a.seq - b.seq)) {
    const childId = event.childId;
    if (!childId) continue;

    if (event.kind === "child.started") {
      if (children.has(childId)) continue;
      const summary = event.state?.summary?.trim() || null;
      children.set(childId, childFromEvent(event, childId, "running", summary));
      continue;
    }

    let child = children.get(childId);
    if (!child) {
      if (event.kind !== "child.completed") continue;
      child = childFromEvent(
        event,
        childId,
        statusFromCompletion(event.status),
        null,
      );
      children.set(childId, child);
    }
    const at = timestampOf(event);

    if (event.kind === "child.updated") {
      const progress = event.state?.summary?.trim() || event.status?.trim() || null;
      applyState(child, event.state);
      if (!event.state?.status) child.status = statusFromUpdate(event.status, child.status);
      child.progress = progress;
      child.card.status = progress;
      child.card.lastActivityAt = at;
      child.recentActivity = appendActivity(child.recentActivity, at, progress);
      continue;
    }

    if (event.kind === "child.completed") {
      applyState(child, event.state);
      child.status = statusFromCompletion(event.status);
      child.resultText = event.result?.trim() || event.state?.summary?.trim() || null;
      if (child.resultText) {
        child.card.status ??= child.resultText;
        child.recentActivity = appendActivity(child.recentActivity, at, child.resultText);
      }
      child.card.lastActivityAt = at;
    }
  }

  const cards = [...children.values()].map(({ card }) => card);
  const fidelity = new Map<string, CanonicalChildFidelity>();
  for (const child of children.values()) {
    const value = fidelityOf(child);
    for (const alias of child.card.aliases) fidelity.set(alias, value);
  }

  return { cards, ownerByStep: new Map(), fidelity };
}

/** Re-key exact native step attribution from the legacy step projection onto the
 * stable canonical card ids. Aliases are provider identities, never display text. */
export function remapCanonicalOwnerByStep(
  canonicalCards: readonly SubagentCard[],
  legacy: SubagentModel,
): ReadonlyMap<string, string> {
  const canonicalByAlias = new Map<string, string>();
  for (const card of canonicalCards) {
    for (const alias of card.aliases) canonicalByAlias.set(alias, card.id);
  }

  const canonicalIdByLegacyId = new Map<string, string>();
  for (const card of legacy.cards) {
    const canonicalId = card.aliases
      .map((alias) => canonicalByAlias.get(alias))
      .find((id): id is string => id !== undefined);
    if (canonicalId) canonicalIdByLegacyId.set(card.id, canonicalId);
  }

  return new Map(
    [...legacy.ownerByStep].flatMap(([stepId, legacyCardId]) => {
      const canonicalId = canonicalIdByLegacyId.get(legacyCardId);
      return canonicalId ? [[stepId, canonicalId] as const] : [];
    }),
  );
}

/** Resolve the durable spawn step that carries a canonical child's full prompt. */
export function legacySpawnStepIdForCanonical(
  canonicalCard: SubagentCard,
  legacy: SubagentModel,
): string | null {
  const aliases = new Set(canonicalCard.aliases);
  return legacy.cards.find((card) => card.aliases.some((alias) => aliases.has(alias)))?.id ?? null;
}
