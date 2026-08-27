// Windowed initial loading for long threads - the pure model + wire decode.
// The session page first fetches the thread OUTLINE (cheap per-turn skeletons,
// GET /api/runs/:id/thread-outline). When the thread exceeds
// WINDOWED_THREAD_LIMIT turns, the initial load is the thread ROOT plus the
// last INITIAL_TAIL_TURNS turns in full; every other turn renders as a
// placeholder stub sized from its outline entry, and scrolling into stubs
// fetches that island (GET /api/runs/:id/turns, bounded ids) on demand. At or
// under the limit the page keeps today's full `?thread=1` load exactly.
// This bounds FIRST-PAINT HTTP payload only: the current thread SSE protocol
// still replays its full durable snapshot after connect. Compact thread-wide
// child summaries belong to the execution-summary projection lane; until that
// lands, every active turn is eagerly loaded so controls and live child state
// never depend on an unloaded transcript island.
// No "use client": the server page and the client session view share this.

import {
  type ApiRun,
  type ApiThreadOutlineTurn,
  decodeApiRun,
  decodeThreadOutlineTurn,
} from "@useagent/agent-client/wire";
import type { Turn } from "./conversation";

export type { ApiThreadOutlineTurn };

/** Threads at or under this many turns load fully - exactly today's behavior. */
export const WINDOWED_THREAD_LIMIT = 60;

/** How many trailing turns the windowed initial load fetches in full. The tail
 *  is where the user lands (bottom-pinned) and where live streaming appends. */
export const INITIAL_TAIL_TURNS = 40;

/** Client mirror of the backend's per-request id bound (MAX_TURN_FETCH_IDS). */
export const TURN_FETCH_CHUNK = 30;

/** Decode a `{ turns }` outline response; malformed entries are dropped. */
export function decodeThreadOutline(data: unknown): ApiThreadOutlineTurn[] {
  const turns = (data as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) return [];
  return turns
    .map(decodeThreadOutlineTurn)
    .filter((turn): turn is ApiThreadOutlineTurn => turn !== null);
}

/** Decode a `{ turns }` windowed-fetch response into full runs (same ApiRun
 *  wire shape as `?thread=1`); malformed entries are dropped. */
export function decodeTurnsResponse(data: unknown): ApiRun[] {
  const turns = (data as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) return [];
  return turns.map(decodeApiRun).filter((run): run is ApiRun => run !== null);
}

/** The ids the windowed initial load fetches fully: the thread ROOT (the page's
 *  identity - rootRunId, store seeding, and the git chips all read thread[0]),
 *  every non-terminal turn (controls must never target a placeholder), plus the
 *  last INITIAL_TAIL_TURNS turns. Outline order, no duplicates. */
export function initialTurnIds(outline: readonly ApiThreadOutlineTurn[]): string[] {
  if (outline.length <= INITIAL_TAIL_TURNS + 1) return outline.map((turn) => turn.id);
  const [root] = outline;
  if (!root) return [];
  const required = new Set<string>();
  required.add(root.id);
  for (const turn of outline.slice(-INITIAL_TAIL_TURNS)) required.add(turn.id);
  for (const turn of outline) {
    if (turn.status === "queued" || turn.status === "running") required.add(turn.id);
  }
  return outline.filter((turn) => required.has(turn.id)).map((turn) => turn.id);
}

/** Missing requested ids after decoding a successful island response. A 200 is
 *  not proof that every requested run arrived: malformed entries are dropped at
 *  the wire boundary and a concurrently unavailable row may be absent. */
export function missingRequestedTurnIds(
  requested: readonly string[],
  decoded: readonly ApiRun[],
): string[] {
  const received = new Set(decoded.map((run) => run.id));
  return requested.filter((id) => !received.has(id));
}

/** Strict initial-SSR decode. The root and required tail/active turns are the
 *  state/control seed for the page, so a partial, duplicate, extra, or malformed
 *  200 response is unsafe and must fall back to the full-thread endpoint. */
export function decodeExactTurnsResponse(
  data: unknown,
  requested: readonly string[],
): ApiRun[] | null {
  const decoded = decodeTurnsResponse(data);
  if (decoded.length !== requested.length) return null;
  const requestedSet = new Set(requested);
  if (requestedSet.size !== requested.length) return null;
  const received = new Set(decoded.map((run) => run.id));
  if (received.size !== decoded.length || received.size !== requestedSet.size) return null;
  for (const id of received) {
    if (!requestedSet.has(id)) return null;
  }
  return decoded;
}

/** Split run ids into backend-bounded fetch chunks (TURN_FETCH_CHUNK each). */
export function chunkTurnIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += TURN_FETCH_CHUNK) {
    chunks.push(ids.slice(i, i + TURN_FETCH_CHUNK));
  }
  return chunks;
}

/** Canonical thread order - created_at then id, the backend's thread ordering
 *  (ISO timestamps compare lexicographically). Merges parallel chunk fetches
 *  back into one oldest→newest list. */
export function sortRunsByThreadOrder(runs: readonly ApiRun[]): ApiRun[] {
  return runs.toSorted((a, b) =>
    a.created_at < b.created_at
      ? -1
      : a.created_at > b.created_at
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
}

/** A placeholder Turn for a not-yet-loaded outline entry. It NEVER materializes
 *  into a TurnBlock (the turn window keeps `pendingOutline` rows as sized
 *  placeholders), so the empty run fields are never rendered; only the id, the
 *  status, created_at, and the outline sizing data are real. */
export function outlineStubTurn(entry: ApiThreadOutlineTurn, threadId: string): Turn {
  const run: ApiRun = {
    id: entry.id,
    org_id: null,
    user_id: null,
    project_id: null,
    prompt: "",
    model: "",
    engine: "opencode",
    status: entry.status,
    summary: null,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: threadId,
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: entry.created_at,
    updated_at: entry.created_at,
    steps: [],
  };
  return {
    run,
    steps: [],
    status: entry.status,
    summary: null,
    // Never live: a stub must not be forced real by the window's live rule -
    // the tail (where anything live sits) is always fully loaded.
    live: false,
    liveText: "",
    liveReasoning: "",
    pendingOutline: { stepCount: entry.step_count, hasSummary: entry.has_summary },
  };
}
