"use client";

import { useCallback, useMemo, useRef } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import type { Turn } from "./conversation";
import type { NativeSnapshot } from "./native-store";
import type { ThreadRunView, ThreadSnapshot } from "./thread-store";
import { type ApiRun, isLiveStatus } from "./types";
import {
  type ApiThreadOutlineTurn,
  chunkTurnIds,
  decodeTurnsResponse,
  missingRequestedTurnIds,
  outlineStubTurn,
} from "./windowed-thread";

interface WindowedThreadInput {
  rootId: string;
  thread: readonly ApiRun[];
  snapshot: ThreadSnapshot;
  initialOutline: readonly ApiThreadOutlineTurn[] | null;
  mergeRuns: (runs: readonly ApiRun[]) => void;
}

/** Owns long-thread island loading and materializes the complete ordered Turn
 * list from loaded runs plus outline stubs. Kept outside SessionView so the
 * session shell stays focused on controls and surfaces. */
export function useWindowedThread({
  rootId,
  thread,
  snapshot,
  initialOutline,
  mergeRuns,
}: WindowedThreadInput): {
  turns: Turn[];
  onTurnsNeeded: (runIds: readonly string[]) => void;
} {
  const requestedTurnsRef = useRef(new Set<string>());
  const onTurnsNeeded = useCallback(
    (runIds: readonly string[]) => {
      const wanted = runIds.filter((id) => !requestedTurnsRef.current.has(id));
      if (wanted.length === 0) return;
      for (const id of wanted) requestedTurnsRef.current.add(id);
      void (async () => {
        for (const chunk of chunkTurnIds(wanted)) {
          try {
            const res = await backendFetch(`/api/runs/${rootId}/turns?ids=${chunk.join(",")}`);
            if (!res.ok) throw new Error(`backend ${res.status}`);
            const decoded = decodeTurnsResponse(await res.json());
            mergeRuns(decoded);
            for (const id of missingRequestedTurnIds(chunk, decoded)) {
              requestedTurnsRef.current.delete(id);
            }
          } catch {
            for (const id of chunk) requestedTurnsRef.current.delete(id);
          }
        }
      })();
    },
    [rootId, mergeRuns],
  );

  const turnCacheRef = useRef(
    new Map<string, { source: ApiRun | ThreadRunView | ApiThreadOutlineTurn; turn: Turn }>(),
  );
  const turns = useMemo(() => {
    const nativeFor = (view: ThreadRunView): NativeSnapshot | undefined =>
      isLiveStatus(view.status)
        ? view.native
        : view.native.nativeFrames.length > 0
          ? view.native
          : undefined;
    const cache = turnCacheRef.current;
    const next = new Map<
      string,
      { source: ApiRun | ThreadRunView | ApiThreadOutlineTurn; turn: Turn }
    >();
    const toTurn = (run: ApiRun): Turn => {
      const view = snapshot.byId.get(run.id);
      const source = view ?? run;
      const cached = cache.get(run.id);
      if (cached && cached.source === source) {
        next.set(run.id, cached);
        return cached.turn;
      }
      const turn: Turn = view
        ? {
            run: view.run,
            steps: view.native.steps,
            status: view.status,
            summary: view.summary,
            live: isLiveStatus(view.status),
            liveText: view.liveText,
            liveReasoning: view.liveReasoning,
            native: nativeFor(view),
            canonical: view.canonical,
            canonicalComplete: view.canonicalComplete,
          }
        : {
            run,
            steps: run.steps,
            status: run.status,
            summary: run.summary,
            live: false,
            liveText: "",
            liveReasoning: "",
            native: undefined,
          };
      next.set(run.id, { source, turn });
      return turn;
    };

    let list: Turn[];
    if (!initialOutline) {
      list = thread.map(toTurn);
    } else {
      const inOutline = new Set(initialOutline.map((entry) => entry.id));
      list = initialOutline.map((entry) => {
        const view = snapshot.byId.get(entry.id);
        if (view) return toTurn(view.run);
        const cached = cache.get(entry.id);
        if (cached && cached.source === entry) {
          next.set(entry.id, cached);
          return cached.turn;
        }
        const turn = outlineStubTurn(entry, rootId);
        next.set(entry.id, { source: entry, turn });
        return turn;
      });
      for (const run of thread) {
        if (!inOutline.has(run.id)) list.push(toTurn(run));
      }
    }
    turnCacheRef.current = next;
    return list;
  }, [thread, snapshot.byId, initialOutline, rootId]);

  return { turns, onTurnsNeeded };
}
