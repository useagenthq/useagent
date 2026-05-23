"use client";

import { decodeArtifactResult } from "@skynet/agent-client";
import { useEffect, useRef } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { autoOpenArtifactId } from "./workpiece-auto-open";
import type { OpenWorkpieceTab } from "./workspace-pane";

/** Auto-opens a canonical workpiece into the session's Workspace pane the moment
 *  an agent publishes it in the currently-viewed thread. Subscribes to the org
 *  invalidation stream, thread-scopes the "created" signal (never historical, never
 *  another thread), and fetches the descriptor ONCE per id to confirm it is a
 *  canonical workpiece before handing `{ id, name }` to the caller - a raw binary
 *  is left with its card/download. Failures are silent: the conversation card stays
 *  clickable as the manual fallback. */
export function useWorkpieceAutoOpen(
  rootThreadId: string,
  onAutoOpen: (tab: OpenWorkpieceTab) => void,
): void {
  const onAutoOpenRef = useRef(onAutoOpen);
  onAutoOpenRef.current = onAutoOpen;
  // Each id is handled once: a closed tab never re-opens (created fires once), and
  // a duplicated signal never doubles the fetch.
  const handledRef = useRef<Set<string>>(new Set());
  const controllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  useOrgChanges((change) => {
    const artifactId = autoOpenArtifactId(change, rootThreadId);
    if (!artifactId || handledRef.current.has(artifactId)) return;
    handledRef.current.add(artifactId);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    void (async () => {
      try {
        const response = await backendFetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = decodeArtifactResult(await response.json());
        // Only a canonical workpiece opens in the pane; anything else keeps its card.
        if (result?.artifact.workpiece) {
          onAutoOpenRef.current({ id: result.artifact.id, name: result.artifact.name });
        }
      } catch {
        // Transient; the conversation artifact card remains the manual open path.
      } finally {
        controllersRef.current.delete(controller);
      }
    })();
  });
}
