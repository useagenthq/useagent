import type { CanonicalChildState } from "@useagent/agent-harness/canonical";
import {
  type CanonicalEventLike,
  collectToolLifecycles,
  projectToolLifecycle,
} from "./canonical-timeline";
import { type ChildUsage, mergeChildUsage, normalizeChildUsage } from "./child-usage";
import {
  type ChildFidelity,
  type ChildStatus,
  deriveChildFidelity,
  type NativeFrame,
} from "./native-events";
import { deriveSubagents, nativeOf, type SubagentCard, type SubagentModel } from "./subagents";
import {
  type ApiStep,
  asRecord,
  isRenderableTimelineStep,
  parseStepCode,
} from "./types";

export type CanonicalChildStateLike = Readonly<CanonicalChildState>;

export type CanonicalChildEventLike = CanonicalEventLike & {
  /** Durable product run id. Gateway children use this as their child identity;
   * provider-native children use identity.nativeSessionId instead. */
  readonly runId?: string;
  readonly state?: CanonicalChildStateLike;
};

export interface CanonicalChildFidelity extends ChildFidelity {
  readonly prompt: string | null;
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
  prompt: string | null;
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
  child.prompt = state.prompt?.trim() || child.prompt;
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
    prompt: null,
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
      status: null,
      startedAt,
      lastActivityAt: startedAt,
    },
  };
  applyState(child, event.state);
  child.card.status = cardStatus;
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
    prompt: child.prompt,
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
    let synthesizedFromCompletion = false;
    if (!child) {
      if (event.kind !== "child.completed") continue;
      synthesizedFromCompletion = true;
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
      applyState(child, event.state);
      if (!event.state?.status) child.status = statusFromUpdate(event.status, child.status);
      // Structured state separates lifecycle status from semantic summary. Old
      // canonical rows without a state object used `status` for both, so retain
      // that legacy fallback only for those rows.
      const progress = event.state
        ? (event.state.summary?.trim() || null)
        : (event.status?.trim() || null);
      child.progress = progress;
      if (progress) child.card.status = progress;
      child.card.lastActivityAt = at;
      child.recentActivity = appendActivity(child.recentActivity, at, progress);
      continue;
    }

    if (event.kind === "child.completed") {
      applyState(child, event.state);
      child.status = statusFromCompletion(event.status);
      child.resultText = event.result?.trim() || event.state?.summary?.trim() || null;
      if (child.resultText) {
        if (synthesizedFromCompletion || !child.card.status) child.card.status = child.resultText;
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

// ── The ONE merged children projection (rail + inline fold read the same view) ──

/** Canonical fidelity when the canonical lane carries the child; the legacy
 *  native-frame fidelity otherwise. Canonical-only fields stay optional. */
export type MergedChildFidelity = ChildFidelity &
  Partial<Pick<CanonicalChildFidelity, "prompt" | "model" | "role" | "resumable">>;

export interface ChildrenView {
  readonly cards: readonly SubagentCard[];
  /** stepId -> owning card id, for every durable step attributed to a child. */
  readonly ownerByStep: ReadonlyMap<string, string>;
  /** Keyed by every card alias (call id + child session id). */
  readonly fidelity: ReadonlyMap<string, MergedChildFidelity>;
  /** The legacy step projection, kept so spawn-step lookups stay exact. */
  readonly legacy: SubagentModel;
}

const TERMINAL_STATUSES = new Set<ChildStatus>(["completed", "failed", "cancelled", "interrupted"]);

/** Canonical wins field-by-field; the native lane fills what canonical does not
 *  carry (result text, usage, activity). A native TERMINAL status corrects a
 *  canonical child that never saw its completion frame - never the reverse. */
function mergeFidelity(
  canonical: CanonicalChildFidelity | undefined,
  native: ChildFidelity | undefined,
): MergedChildFidelity | undefined {
  if (!canonical) return native;
  if (!native) return canonical;
  const status =
    !TERMINAL_STATUSES.has(canonical.status) && TERMINAL_STATUSES.has(native.status)
      ? native.status
      : canonical.status;
  return {
    ...canonical,
    status,
    resultText: canonical.resultText ?? native.resultText,
    progress: canonical.progress ?? native.progress,
    lastToolName: canonical.lastToolName ?? native.lastToolName,
    recentActivity:
      canonical.recentActivity.length > 0 ? canonical.recentActivity : native.recentActivity,
    usage: canonical.usage ?? native.usage,
  };
}

/**
 * Merge the three child lanes into ONE view: canonical lifecycle events name the
 * cards when present (legacy spawn steps otherwise); durable steps attribute to
 * cards by exact native child-session match (canonical cards included); fidelity
 * is canonical-first with the native lane as fallback, so a child whose result
 * only exists in native frames still reads truthfully.
 */
export function deriveChildrenView(
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  canonicalEvents: readonly CanonicalChildEventLike[],
): ChildrenView {
  const canonical = deriveCanonicalChildren(canonicalEvents);
  const legacy = deriveSubagents(steps);
  const native = deriveChildFidelity(frames);

  if (canonical.cards.length === 0) {
    return { cards: legacy.cards, ownerByStep: legacy.ownerByStep, fidelity: native, legacy };
  }

  // Exact legacy attribution remapped onto canonical ids, then canonical's own
  // child-session attribution for steps the legacy projection had no card for
  // (ACP/canonical-only runs never emit a legacy spawn step).
  const ownerByStep = new Map(remapCanonicalOwnerByStep(canonical.cards, legacy));
  const cardByChildSession = new Map(
    canonical.cards.flatMap((card) =>
      card.childSessionId ? [[card.childSessionId, card.id] as const] : [],
    ),
  );
  for (const step of steps) {
    if (ownerByStep.has(step.id)) continue;
    const sessionId = nativeOf(step)?.sessionID;
    const cardId = cardByChildSession.get(step.run_id) ??
      (sessionId ? cardByChildSession.get(sessionId) : undefined);
    if (cardId) ownerByStep.set(step.id, cardId);
  }

  const fidelity = new Map<string, MergedChildFidelity>();
  for (const card of canonical.cards) {
    const canonicalFidelity = card.aliases
      .map((alias) => canonical.fidelity.get(alias))
      .find((value): value is CanonicalChildFidelity => value !== undefined);
    const nativeFidelity = card.aliases
      .map((alias) => native.get(alias))
      .find((value): value is ChildFidelity => value !== undefined);
    const merged = mergeFidelity(canonicalFidelity, nativeFidelity);
    if (merged) for (const alias of card.aliases) fidelity.set(alias, merged);
  }

  return { cards: canonical.cards, ownerByStep, fidelity, legacy };
}

// ── Child timeline (the subagent detail pane's real activity) ────────────────

export type ChildTimelineEntry =
  | { readonly kind: "tool"; readonly key: string; readonly step: ApiStep }
  | { readonly kind: "text"; readonly key: string; readonly text: string };

function isMeaningfulChildTool(step: ApiStep): boolean {
  if (!isRenderableTimelineStep(step)) return false;
  const code = asRecord(parseStepCode(step));
  const tool = typeof code?.tool === "string" ? code.tool.toLocaleLowerCase() : null;
  // Collaboration wrappers are transport receipts. The child lifecycle and
  // child-owned canonical events are the semantic source; never render a second
  // generic tool row for the wrapper itself.
  if (tool === "collab_agent_tool_call") return false;
  return true;
}

/**
 * The REAL activity of one child, from the canonical events identified as that
 * child session's own (tool lifecycles + assistant text). Durable sidecar steps
 * are preferred for tool detail (same rule as buildTimelineFromCanonical);
 * events the run never persisted still render from their canonical projection.
 */
export function deriveChildTimeline(
  events: readonly CanonicalChildEventLike[],
  stepsById: ReadonlyMap<string, ApiStep>,
  childSessionId: string | null,
): ChildTimelineEntry[] {
  if (!childSessionId) return [];
  const owned = events
    .filter(
      (event) =>
        event.runId === childSessionId || event.identity?.nativeSessionId === childSessionId,
    )
    .toSorted((a, b) => a.seq - b.seq);
  if (owned.length === 0) return [];

  const lifecycles = collectToolLifecycles(owned);
  const entries: { entry: ChildTimelineEntry; seq: number }[] = [];
  const seenTextPart = new Set<string>();
  const completedMessages = new Set(
    owned.flatMap((event) =>
      event.kind === "message.completed" && event.messageId && event.text?.trim()
        ? [event.messageId]
        : [],
    ),
  );

  for (const event of owned) {
    if (event.kind === "message.delta" || event.kind === "message.completed") {
      if (!event.text?.trim()) continue;
      if (event.kind === "message.delta" && event.messageId && completedMessages.has(event.messageId)) {
        continue;
      }
      const key = event.kind === "message.completed"
        ? event.messageId ?? event.identity?.nativeEventId ?? String(event.seq)
        : event.identity?.nativePartId ?? event.identity?.nativeEventId ?? String(event.seq);
      if (seenTextPart.has(key)) continue;
      seenTextPart.add(key);
      entries.push({
        entry: { kind: "text", key: `child-text-${key}`, text: event.text },
        seq: event.seq,
      });
      continue;
    }
    if (
      (event.kind === "tool.started" ||
        event.kind === "tool.progress" ||
        event.kind === "tool.completed") &&
      event.toolCallId
    ) {
      const lifecycle = lifecycles.get(event.toolCallId);
      if (!lifecycle || event.seq !== lifecycle.lastSeq) continue;
      const step =
        lifecycle.nativeEventIds
          .toReversed()
          .map((id) => stepsById.get(id))
          .find((candidate): candidate is ApiStep => candidate !== undefined) ??
        projectToolLifecycle(lifecycle, event);
      if (!isMeaningfulChildTool(step)) continue;
      entries.push({ entry: { kind: "tool", key: step.id, step }, seq: lifecycle.firstSeq });
    }
  }

  return entries.toSorted((a, b) => a.seq - b.seq).map(({ entry }) => entry);
}
