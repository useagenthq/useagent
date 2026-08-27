import { notFound } from "next/navigation";
import { SessionView } from "@/components/chat/session-view";
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

// Always render fresh: a session is a live run (cookies + streaming state).
export const dynamic = "force-dynamic";

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
async function loadWindowedTail(
  id: string,
  outline: readonly ApiThreadOutlineTurn[],
): Promise<ApiRun[]> {
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

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Outline first: a cheap per-turn skeleton of the whole thread (no step
  // bodies) that says whether this thread is long enough to window. Unavailable
  // (older backend, transient failure) falls through to the full load, which
  // still 404s a genuinely missing run.
  let outline: ApiThreadOutlineTurn[] = [];
  try {
    const res = await backendFetch(`/api/runs/${id}/thread-outline`);
    if (res.ok) outline = decodeThreadOutline(await res.json());
  } catch {
    outline = [];
  }

  if (outline.length > WINDOWED_THREAD_LIMIT) {
    // Long thread: last ~40 turns (plus the root) fully, placeholders for the
    // rest - older turns stream in as islands when the user scrolls up.
    const tail = await loadWindowedTail(id, outline);
    if (tail.length > 0) {
      return <SessionView initialThread={tail} initialOutline={outline} />;
    }
    // A windowed fetch failed mid-flight - the full load below still works.
  }

  // At or under the limit this is EXACTLY the pre-windowing behavior: the whole
  // conversation (oldest→newest); `toThread` tolerates the pre-thread
  // single-run shape.
  const thread = await loadFullThread(id);
  if (thread.length === 0) notFound();

  // The persistent shell lives in the (thread) layout above this segment.
  return <SessionView initialThread={thread} />;
}
