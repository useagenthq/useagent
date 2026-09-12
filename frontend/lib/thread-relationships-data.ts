import {
  decodeThreadFamilyPage,
  decodeThreadRelationshipEnvelope,
  type ThreadFamilyPage,
  type ThreadRelationship,
} from "@useagent/agent-client";
import { backendFetch } from "@/lib/backend-fetch";

export const THREAD_RELATIONSHIP_PAGE_SIZE = 100;
/** A single UI snapshot is intentionally bounded. `truncated`/`hasMore` stays
 * explicit when an unusually large organization or family exceeds this cap. */
export const THREAD_RELATIONSHIP_SNAPSHOT_LIMIT = 1_000;

export interface ThreadRelationshipIndexSnapshot {
  readonly relationships: readonly ThreadRelationship[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export async function fetchThreadRelationship(
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadRelationship> {
  const path = `/api/threads/${encodeURIComponent(threadId)}/relationship`;
  const response = await backendFetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`thread relationship request failed: ${response.status}`);
  const relationship = decodeThreadRelationshipEnvelope(await response.json());
  if (!relationship) throw new Error("thread relationship response was invalid");
  return relationship;
}

export async function fetchThreadFamily(
  familyThreadId: string,
  signal?: AbortSignal,
): Promise<ThreadFamilyPage> {
  const existing = familyRequests.get(familyThreadId);
  if (existing) return waitForRelationshipRequest(existing, signal);
  const request = fetchThreadRelationshipPages({ kind: "family", familyThreadId })
    .finally(() => {
      if (familyRequests.get(familyThreadId) === request) familyRequests.delete(familyThreadId);
    });
  familyRequests.set(familyThreadId, request);
  return waitForRelationshipRequest(request, signal);
}

const familyRequests = new Map<string, Promise<ThreadFamilyPage>>();

function waitForRelationshipRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void request.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function fetchThreadRelationshipPages(input: {
  readonly kind: "family" | "index";
  readonly familyThreadId?: string;
  readonly signal?: AbortSignal;
}): Promise<ThreadFamilyPage> {
  const children: ThreadRelationship[] = [];
  const indexByThreadId = new Map<string, number>();
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(THREAD_RELATIONSHIP_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const path = input.kind === "family"
      ? `/api/threads/${encodeURIComponent(input.familyThreadId ?? "")}/children?${query}`
      : `/api/threads/relationships?${query}`;
    const response = await backendFetch(path, { cache: "no-store", signal: input.signal });
    if (!response.ok) {
      throw new Error(`thread relationship ${input.kind} request failed: ${response.status}`);
    }
    const raw = await response.json();
    const envelope = input.kind === "index" && raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
    const page = decodeThreadFamilyPage(input.kind === "index" ? {
      children: envelope?.relationships,
      next_cursor: envelope?.next_cursor,
      has_more: envelope?.has_more,
    } : raw);
    if (!page) throw new Error(`thread relationship ${input.kind} response was invalid`);
    for (const child of page.children) {
      const existingIndex = indexByThreadId.get(child.threadId);
      if (existingIndex === undefined) {
        indexByThreadId.set(child.threadId, children.length);
        children.push(child);
      } else {
        children[existingIndex] = child;
      }
    }
    if (!page.hasMore) return { children, nextCursor: null, hasMore: false };
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new Error(`thread relationship ${input.kind} cursor did not advance`);
    }
    cursor = page.nextCursor;
    if (children.length >= THREAD_RELATIONSHIP_SNAPSHOT_LIMIT) {
      return {
        children: children.slice(0, THREAD_RELATIONSHIP_SNAPSHOT_LIMIT),
        nextCursor: cursor,
        hasMore: true,
      };
    }
  }
}

let relationshipIndexRequest: Promise<ThreadRelationshipIndexSnapshot> | null = null;
let relationshipIndexDirty = false;

async function fetchFreshThreadRelationshipIndex(): Promise<ThreadRelationshipIndexSnapshot> {
  let result: ThreadRelationshipIndexSnapshot = {
    relationships: [],
    truncated: false,
    nextCursor: null,
  };
  let failure: unknown = null;
  do {
    relationshipIndexDirty = false;
    try {
      const page = await fetchThreadRelationshipPages({ kind: "index" });
      result = {
        relationships: page.children,
        truncated: page.hasMore,
        nextCursor: page.nextCursor,
      };
      failure = null;
    } catch (error) {
      failure = error;
    }
  } while (relationshipIndexDirty);
  if (failure) throw failure;
  return result;
}

/** Coalesces a burst of org invalidations into one in-flight request plus one latest-state refetch. */
export function fetchThreadRelationshipIndex(
  options: { readonly revalidate?: boolean } = {},
): Promise<ThreadRelationshipIndexSnapshot> {
  if (relationshipIndexRequest) {
    if (options.revalidate) relationshipIndexDirty = true;
    return relationshipIndexRequest;
  }
  const request = fetchFreshThreadRelationshipIndex().finally(() => {
    if (relationshipIndexRequest === request) relationshipIndexRequest = null;
  });
  relationshipIndexRequest = request;
  return request;
}

export function descendantThreadRelationships(
  relationships: readonly ThreadRelationship[],
  threadId: string,
): ThreadRelationship[] {
  const byParent = new Map<string, ThreadRelationship[]>();
  for (const relationship of relationships) {
    if (!relationship.parentThreadId) continue;
    const siblings = byParent.get(relationship.parentThreadId) ?? [];
    siblings.push(relationship);
    byParent.set(relationship.parentThreadId, siblings);
  }
  const descendants: ThreadRelationship[] = [];
  const seen = new Set([threadId]);
  const visit = (parentId: string) => {
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      descendants.push(child);
      visit(child.threadId);
    }
  };
  visit(threadId);
  return descendants;
}
