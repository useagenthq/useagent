"use client";

// Message search for the ⌘K palette: asks the backend (`GET /api/runs/search`)
// for the newest message in each thread that holds every typed word, so a
// thread is found by something said in it, not only by its title.

import * as React from "react";
import { backendFetch } from "@/lib/backend-fetch";

export interface MessageMatch {
  readonly threadId: string;
  readonly runId: string;
  /** The thread root's prompt, the text its title comes from. */
  readonly threadPrompt: string;
  readonly role: "user" | "agent";
  readonly snippet: string;
  readonly createdAt: string;
}

export type MessageSearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly matches: readonly MessageMatch[] }
  | { readonly status: "failed" };

/** Shorter queries match too much to be worth a request. */
export const MESSAGE_SEARCH_MIN_CHARS = 2;
/** Matches the backend's limit on `q`. */
export const MESSAGE_SEARCH_MAX_CHARS = 200;
/** Wait for a pause in typing before asking. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 200;

function decodeMessageMatch(value: unknown): MessageMatch | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.thread_id !== "string" ||
    typeof record.run_id !== "string" ||
    typeof record.thread_prompt !== "string" ||
    (record.role !== "user" && record.role !== "agent") ||
    typeof record.snippet !== "string" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    threadId: record.thread_id,
    runId: record.run_id,
    threadPrompt: record.thread_prompt,
    role: record.role,
    snippet: record.snippet,
    createdAt: record.created_at,
  };
}

/** null when the body is not a search answer at all. */
export function decodeMessageMatches(body: unknown): MessageMatch[] | null {
  if (!body || typeof body !== "object") return null;
  const matches = (body as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return null;
  return matches.map(decodeMessageMatch).filter((match): match is MessageMatch => match !== null);
}

export async function fetchMessageMatches(
  query: string,
  signal?: AbortSignal,
  fetcher: typeof backendFetch = backendFetch,
): Promise<MessageMatch[]> {
  const res = await fetcher(`/api/runs/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`message search failed: ${res.status}`);
  const matches = decodeMessageMatches(await res.json());
  if (!matches) throw new Error("message search answered an unexpected body");
  return matches;
}

/** The query as it is sent: trimmed and cut to the backend's limit; "" when it
 *  is too short to search. */
export function messageSearchQuery(search: string): string {
  const query = search.trim().slice(0, MESSAGE_SEARCH_MAX_CHARS).trim();
  return query.length >= MESSAGE_SEARCH_MIN_CHARS ? query : "";
}

/** The match is the thread's first prompt, its title, and the thread is already
 *  listed by title: showing it again under Messages would repeat it. */
export function visibleMessageMatches(
  matches: readonly MessageMatch[],
  listedThreadIds: ReadonlySet<string>,
): MessageMatch[] {
  return matches.filter(
    (match) =>
      !(
        match.role === "user" &&
        match.runId === match.threadId &&
        listedThreadIds.has(match.threadId)
      ),
  );
}

/** Opens the thread at the turn that holds the message. */
export function messageMatchHref(match: Pick<MessageMatch, "threadId" | "runId">): string {
  return `/session/${encodeURIComponent(match.threadId)}?message=${encodeURIComponent(match.runId)}`;
}

/**
 * Searches messages for `search` after a pause in typing. A newer query aborts
 * the request in flight, so an older answer never replaces a newer one. A
 * failed request is "failed", never an empty list: no answer is not "nothing
 * found".
 */
export function useMessageSearch(
  search: string,
  fetcher: typeof backendFetch = backendFetch,
): MessageSearchState {
  const query = messageSearchQuery(search);
  const [state, setState] = React.useState<MessageSearchState>({ status: "idle" });

  React.useEffect(() => {
    if (!query) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchMessageMatches(query, controller.signal, fetcher).then(
        (matches) => {
          if (!controller.signal.aborted) setState({ status: "ready", matches });
        },
        () => {
          if (!controller.signal.aborted) setState({ status: "failed" });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, fetcher]);

  return state;
}
