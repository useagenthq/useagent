/**
 * The paging of the two firing-history routes, `GET /api/automations/:id/history`
 * and `GET /api/bots/:id/routines/:routineId/history`: one reading of `limit` and
 * `cursor`, and one answer shape.
 */
import { InvalidListCursorError, type ListCursor, parseListCursor } from "../db/list-cursor";
import { FIRING_PAGE_DEFAULT, FIRING_PAGE_MAX, type FiringPage } from "./repo";

export type FiringPageRequest =
  | { readonly limit: number; readonly cursor: ListCursor | null }
  | { readonly error: string };

/** `limit` is 1 to 200 (default 50; a number out of range is held to it, as the
 *  artifact list does); `cursor` is a `next_cursor` this route answered, and
 *  anything else is refused. */
export function firingPageRequest(limit: string | undefined, cursor: string | undefined): FiringPageRequest {
  const requested = Number.parseInt(limit ?? "", 10);
  const size = Number.isFinite(requested) ? Math.min(FIRING_PAGE_MAX, Math.max(1, requested)) : FIRING_PAGE_DEFAULT;
  if (cursor === undefined) return { limit: size, cursor: null };
  try {
    return { limit: size, cursor: parseListCursor(cursor) };
  } catch (error) {
    if (error instanceof InvalidListCursorError) return { error: error.message };
    throw error;
  }
}

export function firingPageBody(page: FiringPage) {
  return { firings: page.firings, has_more: page.nextCursor !== null, next_cursor: page.nextCursor };
}
