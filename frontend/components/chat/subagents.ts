// Subagent attribution — turn a run's flat, ordered `ApiStep[]` projection into
// the parent/child structure the Agents rail and subagent pane render. One job:
// group steps into subagent cards and attribute each nested step to the card
// whose native OpenCode child session it ran in. Pure and deterministic.
//
// Since backend commit 83c6439 every translated step carries the native OpenCode
// ids in `code_json.native`. A tool/file step carries the session it ran in
// (`sessionID`) — the root session for the primary agent, a child session for a
// subagent's own work. A subagent spawn card additionally identifies the child
// session it launched: explicitly via `native.childSessionID` (the `subtask` part
// path) or, for the `task`-tool path real runs emit, inside the tool output XML
// (`<task id="ses_…">`). Matching a step's `sessionID` to a card's child session
// attributes it exactly — even with N concurrent subagents interleaved in one
// ordered stream. Pre-83c6439 steps carry no native ids and fall back to the
// legacy "↳ marker → most-recently-spawned card" heuristic.

import { asRecord, deriveTrace, parseStepCode, type ApiStep } from "./types";
// The native-id reader is shared with the native session store (native-store.ts)
// — one parser for `code_json.native`. Re-exported here so existing importers of
// `nativeOf`/`NativeIds` from this module keep resolving.
import { nativeOf, readString, type NativeIds } from "./native-ids";

export { nativeOf, type NativeIds };

/** The `<task id="…">` task tool writes into its output once the child exists. */
const TASK_CHILD_ID = /<task\s+id="([^"]+)"/;

/** The child session id a subagent-spawn card launched, if discoverable:
 *  `native.childSessionID` (subtask path) else the `<task id>` in the task tool's
 *  output (present once the child completes). Null while still unknown. */
export function childSessionOf(step: ApiStep): string | null {
  const native = nativeOf(step);
  if (native?.childSessionID) return native.childSessionID;
  const code = asRecord(parseStepCode(step));
  const output = readString(code?.output);
  const match = output ? TASK_CHILD_ID.exec(output) : null;
  return match ? match[1] : null;
}

/** One subagent card plus its latest attributed nested activity. */
export interface SubagentCard {
  /** Spawn step id — stable React key. */
  readonly id: string;
  /** Description after "Subagent — " (reuses the trace grammar's derivation). */
  readonly title: string;
  /** Native child session this card owns; null until known (or legacy runs). */
  readonly childSessionId: string | null;
  /** The parent's `task`-tool call id — links this card to its native status
   *  frame (`deriveChildFidelity`). Null on legacy/pre-native runs. */
  readonly callId: string | null;
  /** Stable ids that can refer to this child in native T3/OpenCode activity
   *  frames. T3 may use the tool call id on `collab_agent_tool_call` and the
   *  child `taskId` on `task.*` lifecycle rows. */
  readonly aliases: readonly string[];
  /** Latest attributed nested activity label; null until the first one lands. */
  status: string | null;
  /** Spawn step `created_at`, ms. */
  readonly startedAt: number;
  /** Last attributed activity `created_at`, ms — freezes the elapsed timer. */
  lastActivityAt: number | null;
}

export interface SubagentModel {
  readonly cards: readonly SubagentCard[];
  /** stepId → owning card id, for every step attributed to a subagent. */
  readonly ownerByStep: ReadonlyMap<string, string>;
}

/** How a nested step was attributed to its owning card: `native` = exact
 *  child-session match, `legacy` = pre-stamp ↳ fallback, `none` = unattributed. */
export type Attribution =
  | { readonly kind: "native"; readonly card: SubagentCard }
  | { readonly kind: "legacy"; readonly card: SubagentCard }
  | { readonly kind: "none" };

const UNATTRIBUTED: Attribution = { kind: "none" };
const NESTED_MARKER = /^↳\s*/;

/** Placeholder objectives that are transport noise, not a real spawn target. A
 *  subagent-shaped tool row whose only "description" is one of these (and that
 *  resolves no child session) is an anonymous tool call, not an agent - some
 *  engines chip such rows `subagent` and label them "Tool". */
const PLACEHOLDER_OBJECTIVES = new Set([
  "tool",
  "task",
  "subagent",
  "agent",
  "mcp tool call",
  "tool started",
  "task started",
  "subagent started",
]);

/** A real, non-placeholder objective (description/prompt) the spawn card can
 *  title itself with; null when the row names no real work. */
function spawnObjective(step: ApiStep): string | null {
  const code = asRecord(parseStepCode(step));
  const input = asRecord(code?.input);
  const raw = readString(input?.description) ?? readString(input?.prompt);
  const trimmed = raw?.trim();
  return trimmed && !PLACEHOLDER_OBJECTIVES.has(trimmed.toLowerCase()) ? trimmed : null;
}

const isTaskLifecycle = (step: ApiStep): boolean => {
  const code = asRecord(parseStepCode(step));
  return (
    readString(code?.source) === "t3" &&
    readString(code?.activityKind)?.startsWith("task.") === true
  );
};

const isSpawn = (step: ApiStep): boolean => {
  if (step.chip !== "subagent") return false;
  const code = asRecord(parseStepCode(step));
  // Pre-code legacy subagent rows carry their identity in the label; keep them.
  if (!code) return true;
  // A REAL spawn resolves a child session, or at least names real work. A
  // subagent-shaped transport row with neither (a bare "Tool"/"subagent"
  // placeholder some engines chip as `subagent`) is an anonymous tool call, not
  // an agent - never card it into the rail.
  return childSessionOf(step) !== null || spawnObjective(step) !== null;
};

function spawnCard(step: ApiStep): SubagentCard {
  const childSessionId = childSessionOf(step);
  const callId = nativeOf(step)?.callID ?? null;
  const aliases = [...new Set([callId, childSessionId].filter((id): id is string => !!id))];
  // Prefer the real objective; fall back to a plain "Subagent" rather than a
  // placeholder tool verb so a card never reads a bare "Tool"/"Task".
  const derived = deriveTrace(step).target.trim();
  const title =
    derived && !PLACEHOLDER_OBJECTIVES.has(derived.toLowerCase()) ? derived : "Subagent";
  return {
    id: step.id,
    title,
    childSessionId,
    callId,
    aliases,
    status: null,
    startedAt: Date.parse(step.created_at),
    lastActivityAt: null,
  };
}

/**
 * Decide which card (if any) a non-spawn step belongs to.
 *
 * Native-stamped steps attribute ONLY by exact child-session match; a native
 * step we can't yet match (a grandchild, or a child whose card hasn't resolved
 * its id) is deliberately left unattributed rather than mis-guessed — guessing
 * reintroduces the spawn-order bug this module removes. Only steps with NO native
 * ids (pre-83c6439 runs) use the legacy "↳ marker → last card" heuristic.
 */
export function attribute(
  step: ApiStep,
  byChildSession: ReadonlyMap<string, SubagentCard>,
  byCallId: ReadonlyMap<string, SubagentCard>,
  cards: readonly SubagentCard[],
): Attribution {
  const native = nativeOf(step);
  if (native) {
    const owner =
      (native.sessionID ? byChildSession.get(native.sessionID) : undefined) ??
      (native.callID && isTaskLifecycle(step) ? byCallId.get(native.callID) : undefined);
    return owner ? { kind: "native", card: owner } : UNATTRIBUTED;
  }
  if (NESTED_MARKER.test(step.label ?? "")) {
    const last = cards.at(-1);
    if (last) return { kind: "legacy", card: last };
  }
  return UNATTRIBUTED;
}

function recordActivity(card: SubagentCard, step: ApiStep): void {
  const label = (step.label ?? "").replace(NESTED_MARKER, "").trim();
  if (label) card.status = label;
  card.lastActivityAt = Date.parse(step.created_at);
}

/**
 * Fold a run's ordered steps into subagent cards with their nested activity.
 * Single pass: each spawn opens a card (indexed by its child session where
 * known); each following step is attributed via {@link attribute} and, when
 * owned, updates that card's latest-activity status and timer.
 */
export function deriveSubagents(steps: readonly ApiStep[]): SubagentModel {
  const cards: SubagentCard[] = [];
  const byChildSession = new Map<string, SubagentCard>();
  const byCallId = new Map<string, SubagentCard>();
  const ownerByStep = new Map<string, string>();

  for (const step of steps) {
    if (isSpawn(step)) {
      const card = spawnCard(step);
      cards.push(card);
      if (card.childSessionId) byChildSession.set(card.childSessionId, card);
      for (const alias of card.aliases) byCallId.set(alias, card);
      continue;
    }

    const result = attribute(step, byChildSession, byCallId, cards);
    switch (result.kind) {
      case "none":
        break;
      case "native":
      case "legacy":
        ownerByStep.set(step.id, result.card.id);
        recordActivity(result.card, step);
        break;
      default:
        result satisfies never;
    }
  }

  return { cards, ownerByStep };
}
