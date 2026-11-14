/**
 * The pages of a firing history (`GET /api/automations/:id/history` and
 * `GET /api/bots/:id/routines/:routineId/history`): newest first, a page at a
 * time, `next_cursor` asking for the older firings.
 */
import { envelope } from "@/lib/runs";

/** The fields both history readers key on; each keeps its own row type. */
export interface FiringRow {
  readonly id: string;
  readonly fired_at: string;
}

export interface FiringPage<T extends FiringRow> {
  readonly firings: T[];
  /** Send back as `cursor` for older firings; null when there are none. An
   *  older backend answers every firing at once and no cursor. */
  readonly nextCursor: string | null;
}

/** Read a history answer: the `firings` envelope, as every list here reads it,
 *  and its `next_cursor` when there is one. */
export function decodeFiringPage<T extends FiringRow>(body: unknown): FiringPage<T> {
  const cursor = body && typeof body === "object" ? (body as { next_cursor?: unknown }).next_cursor : null;
  return {
    firings: envelope(body, "firings") as T[],
    nextCursor: typeof cursor === "string" && cursor ? cursor : null,
  };
}

/** The history path with the page's query: the cursor, when asking for older firings. */
export function firingPagePath(path: string, cursor: string | null): string {
  return cursor ? `${path}?${new URLSearchParams({ cursor })}` : path;
}

/**
 * A refreshed newest page over what is loaded. Before anything older was
 * loaded, the page is the whole list. After, the page goes in front and the
 * older rows already loaded stay, without repeating one the page now holds,
 * and the older rows' cursor still asks for what follows them.
 */
export function withRefreshedPage<T extends FiringRow>(
  current: FiringPage<T> | null,
  page: FiringPage<T>,
  olderLoaded: boolean,
): FiringPage<T> {
  if (!current || !olderLoaded) return page;
  const fresh = new Set(page.firings.map((firing) => firing.id));
  return {
    firings: [...page.firings, ...current.firings.filter((firing) => !fresh.has(firing.id))],
    nextCursor: current.nextCursor,
  };
}

/** An older page after what is loaded, without repeating a row already shown. */
export function withOlderPage<T extends FiringRow>(current: FiringPage<T>, page: FiringPage<T>): FiringPage<T> {
  const shown = new Set(current.firings.map((firing) => firing.id));
  return {
    firings: [...current.firings, ...page.firings.filter((firing) => !shown.has(firing.id))],
    nextCursor: page.nextCursor,
  };
}
