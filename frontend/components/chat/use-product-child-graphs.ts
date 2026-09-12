"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadRelationship } from "@useagent/agent-client";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import {
  EXECUTION_GRAPH_CLIENT_MODE,
  fetchExecutionGraph,
  type ExecutionGraphResponse,
} from "./execution-graph-client";

interface ProductGraphCacheEntry {
  readonly runId: string;
  readonly activity: string;
  readonly invalidation: number;
  readonly graph: ExecutionGraphResponse;
}

export interface ProductGraphBinding {
  readonly threadId: string;
  readonly runId: string;
  readonly activity: string;
  readonly invalidation: number;
}

export function matchesProductGraphInvalidation(
  binding: ProductGraphBinding,
  change: OrgChange,
): boolean {
  if (change.type !== "run" && change.type !== "execution_graph") return false;
  return binding.threadId === change.threadId &&
    (change.type !== "execution_graph" || binding.runId === change.runId);
}

export function expandedProductGraphBindings(
  productChildren: readonly ThreadRelationship[],
  collapsed: ReadonlySet<string>,
  invalidations: ReadonlyMap<string, number> = new Map(),
): ProductGraphBinding[] {
  return productGraphBindings(productChildren, invalidations)
    .filter((binding) => !collapsed.has(`product:${binding.threadId}`));
}

export function productGraphBindings(
  productChildren: readonly ThreadRelationship[],
  invalidations: ReadonlyMap<string, number> = new Map(),
): ProductGraphBinding[] {
  return productChildren.map((child) => ({
    threadId: child.threadId,
    runId: child.latestRunId,
    activity: child.latestActivityAt,
    invalidation: invalidations.get(child.threadId) ?? 0,
  }));
}

/** Fetches graph detail only for expanded product children, and refreshes only
 * the child whose relationship activity/run binding changed. */
export function useProductChildGraphs(
  productChildren: readonly ThreadRelationship[],
  collapsed: ReadonlySet<string>,
): ReadonlyMap<string, ExecutionGraphResponse> {
  const [cache, setCache] = useState<ReadonlyMap<string, ProductGraphCacheEntry>>(() => new Map());
  const [invalidations, setInvalidations] = useState<ReadonlyMap<string, number>>(() => new Map());
  const pendingInvalidations = useRef(new Set<string>());
  const invalidationScheduled = useRef(false);
  const bindings = useMemo(
    () => productGraphBindings(productChildren, invalidations),
    [invalidations, productChildren],
  );
  const expanded = useMemo(
    () => expandedProductGraphBindings(productChildren, collapsed, invalidations),
    [collapsed, invalidations, productChildren],
  );
  const refreshKey = expanded
    .map(({ threadId, runId, activity, invalidation }) =>
      `${threadId}:${runId}:${activity}:${invalidation}`
    )
    .join("|");

  useOrgChanges((change) => {
    if (change.type !== "run" && change.type !== "execution_graph") return;
    const binding = bindings.find((item) => matchesProductGraphInvalidation(item, change));
    if (!binding) return;
    pendingInvalidations.current.add(binding.threadId);
    if (invalidationScheduled.current) return;
    invalidationScheduled.current = true;
    queueMicrotask(() => {
      invalidationScheduled.current = false;
      const pending = [...pendingInvalidations.current];
      pendingInvalidations.current.clear();
      setInvalidations((current) => {
        const next = new Map(current);
        for (const threadId of pending) next.set(threadId, (next.get(threadId) ?? 0) + 1);
        return next;
      });
    });
  });

  useEffect(() => {
    if (EXECUTION_GRAPH_CLIENT_MODE !== "read" || expanded.length === 0) {
      setCache(new Map());
      return;
    }
    const pending = expanded.filter(({ threadId, runId, activity, invalidation }) => {
      const entry = cache.get(threadId);
      return !entry || entry.runId !== runId || entry.activity !== activity ||
        entry.invalidation !== invalidation;
    });
    if (pending.length === 0) return;
    const controller = new AbortController();
    void Promise.all(pending.map(async ({ threadId, runId, activity, invalidation }) => ({
      threadId,
      runId,
      activity,
      invalidation,
      graph: await fetchExecutionGraph(runId, controller.signal),
    }))).then((rows) => {
      if (controller.signal.aborted) return;
      setCache((current) => {
        const next = new Map(current);
        for (const { threadId, runId, activity, invalidation, graph } of rows) {
          if (graph) next.set(threadId, { runId, activity, invalidation, graph });
        }
        return next;
      });
    }).catch(() => {
      // Keep prior good child graphs on transient failures.
    });
    return () => controller.abort();
  }, [refreshKey]);

  return useMemo(() => {
    const currentThreads = new Set(productChildren.map((child) => child.threadId));
    return new Map(
      [...cache]
        .filter(([threadId]) => currentThreads.has(threadId))
        .map(([threadId, entry]) => [threadId, entry.graph]),
    );
  }, [cache, productChildren]);
}
