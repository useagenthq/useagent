import { type ApiRun, toThread } from "@/components/chat/types";
import {
  type ApiThreadOutlineTurn,
  chunkTurnIds,
  decodeExactTurnsResponse,
  decodeThreadOutline,
  initialTurnIds,
  sortRunsByThreadOrder,
  WINDOWED_THREAD_LIMIT,
} from "@/components/chat/windowed-thread";
import { backendFetch } from "@/lib/backend-fetch";
import { type InitialThreadRelationshipHint, loadThreadRelationshipHint } from "@/lib/thread-relationship-hint";

/**
 * Everything SessionView needs for its first paint of a thread. Shared by the
 * session page and any surface that embeds a thread (bots), so the windowing
 * rules for long threads live in exactly one place.
 */
export interface ThreadView {
  readonly thread: ApiRun[];
  /** Set only when the thread was windowed (long thread, tail loaded in full). */
  readonly outline: ApiThreadOutlineTurn[] | null;
  readonly relationshipHint: InitialThreadRelationshipHint;
}

/** Full-thread load (`?thread=1`, oldest→newest) - the behavior for threads at
 *  or under the windowing limit, and the fallback when the outline or a
 *  windowed fetch is unavailable. [] on any failure. */
async function loadFullThread(id: string): Promise<ApiRun[]> {
  try {
    const res = await backendFetch(`/api/runs/${id}?thread=1`);
    if (!res.ok) return [];
    return toThread(await res.json());
  } catch {
    return [];
  }
}

/** Windowed initial load: the thread root + the last ~40 turns in full, via the
 *  bounded turns endpoint (chunked to its id cap). [] on any failure - the
 *  caller then falls back to the full load. */
async function loadWindowedTail(id: string, outline: readonly ApiThreadOutlineTurn[]): Promise<ApiRun[]> {
  try {
    const requested = initialTurnIds(outline);
    const chunks = chunkTurnIds(requested);
    const responses = await Promise.all(
      chunks.map((chunk) => backendFetch(`/api/runs/${id}/turns?ids=${chunk.join(",")}`)),
    );
    const runs: ApiRun[] = [];
    for (const [index, res] of responses.entries()) {
      const chunk = chunks[index];
      if (!chunk) return [];
      if (!res.ok) return [];
      const decoded = decodeExactTurnsResponse(await res.json(), chunk);
      if (!decoded) return [];
      runs.push(...decoded);
    }
    const sorted = sortRunsByThreadOrder(runs);
    return decodeExactTurnsResponse({ turns: sorted }, requested) ? sorted : [];
  } catch {
    return [];
  }
}

/**
 * Outline first: a cheap per-turn skeleton that says whether the thread is
 * long enough to window. Long threads get the root + last ~40 turns in full
 * with placeholders for the rest; everything else is the whole conversation.
 * null when the thread does not exist (or nothing could be loaded).
 */
export async function loadThreadView(id: string): Promise<ThreadView | null> {
  let outline: ApiThreadOutlineTurn[] = [];
  try {
    const res = await backendFetch(`/api/runs/${id}/thread-outline`);
    if (res.ok) outline = decodeThreadOutline(await res.json());
  } catch {
    outline = [];
  }

  if (outline.length > WINDOWED_THREAD_LIMIT) {
    const tail = await loadWindowedTail(id, outline);
    if (tail.length > 0) {
      const relationshipHint = await loadThreadRelationshipHint(tail[0]?.thread_id ?? id, backendFetch);
      return { thread: tail, outline, relationshipHint };
    }
    // A windowed fetch failed mid-flight - the full load below still works.
  }

  const thread = await loadFullThread(id);
  if (thread.length === 0) return null;
  const relationshipHint = await loadThreadRelationshipHint(thread[0]?.thread_id ?? id, backendFetch);
  return { thread, outline: null, relationshipHint };
}
