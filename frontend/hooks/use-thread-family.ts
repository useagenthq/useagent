"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadRelationship } from "@useagent/agent-client";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import type { InitialThreadRelationshipHint } from "@/lib/thread-relationship-hint";
import {
  descendantThreadRelationships,
  fetchThreadFamily,
  fetchThreadRelationship,
} from "@/lib/thread-relationships-data";

interface ThreadFamilySnapshot {
  readonly relationship: ThreadRelationship | null;
  readonly parent: ThreadRelationship | null;
  readonly children: readonly ThreadRelationship[];
  readonly loading: boolean;
  readonly error: string | null;
}

export interface ThreadFamilyState extends ThreadFamilySnapshot {
  readonly ready: boolean;
  readonly isProductChild: boolean;
  readonly descendants: readonly ThreadRelationship[];
}

export type ThreadSubmissionLane = "root" | "child" | "blocked";

export function threadSubmissionLane(
  state: Pick<ThreadFamilyState, "ready" | "isProductChild">,
  initialHint: InitialThreadRelationshipHint,
): ThreadSubmissionLane {
  if (state.ready) return state.isProductChild ? "child" : "root";
  if (initialHint === "child" || initialHint === "ambiguous") return "blocked";
  return "root";
}

export function threadFamilyShouldRefresh(
  state: Pick<ThreadFamilyState, "relationship" | "children">,
  currentThreadId: string,
  change: OrgChange,
): boolean {
  if (change.type === "thread_relationship") {
    return change.familyThreadId === currentThreadId ||
      change.familyThreadId === state.relationship?.familyThreadId;
  }
  if (change.type !== "run") return false;
  if (change.threadId === currentThreadId) return true;
  if (change.threadId === state.relationship?.familyThreadId) return true;
  return state.children.some((child) => child.threadId === change.threadId);
}

/** Lightweight family metadata only. Child transcripts keep their own thread stream. */
export function useThreadFamily(threadId: string): ThreadFamilyState {
  const [state, setState] = useState<ThreadFamilySnapshot>({
    relationship: null,
    parent: null,
    children: [],
    loading: true,
    error: null,
  });
  const refreshScheduled = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const relationship = await fetchThreadRelationship(threadId, signal);
      const [family, parent] = await Promise.all([
        fetchThreadFamily(relationship.familyThreadId, signal),
        relationship.parentThreadId
          ? fetchThreadRelationship(relationship.parentThreadId, signal).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!signal?.aborted) {
        setState({ relationship, parent, children: family.children, loading: false, error: null });
      }
    } catch (error) {
      if (!signal?.aborted) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Thread relationship unavailable",
        }));
      }
    }
  }, [threadId]);

  useOrgChanges((change) => {
    if (
      !threadFamilyShouldRefresh(state, threadId, change) ||
      refreshScheduled.current
    ) return;
    refreshScheduled.current = true;
    queueMicrotask(() => {
      refreshScheduled.current = false;
      void load();
    });
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ relationship: null, parent: null, children: [], loading: true, error: null });
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return {
    ...state,
    ready: !state.loading && state.error === null && state.relationship !== null,
    isProductChild: Boolean(state.relationship?.parentThreadId),
    descendants: descendantThreadRelationships(state.children, threadId),
  };
}
