// Ported from a peer tool (Apache-2.0): src/kiro_crew/messaging/renderer.py
//
// The generic "attach a Renderer to a live turn" path. In a peer tool a TurnDriver
// consumes a provider event stream and drives a Renderer's on_* callbacks; here
// the source is useAgent's run bus + turn-stream instead of a provider stream, so
// ANY connector surface renders a run without bespoke per-surface wiring (the
// generic replacement for what slack/watcher.ts does by hand).

import { getRun, type ApiStep } from "../runs/repo";
import type { RunStatus, StepKind } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { turnStream } from "../runs/turn-stream";
import type { Renderer } from "./types";

/** Map a durable step to a Renderer callback, mirroring how a peer tool's TurnDriver
 *  classifies provider tool events: `command`/`file` are tool calls; `task` is a
 *  reasoning/analysis beat → onThinking. `done` is terminal and handled by the
 *  `end` event, not here. */
function feedStep(renderer: Renderer, step: ApiStep): void {
  const kind: StepKind = step.kind;
  if (kind === "done") return; // terminal — the `end` event drives onDone
  if (kind === "task") {
    void renderer.onThinking(step.label);
    return;
  }
  const toolKind = kind === "file" ? "edit" : "execute";
  void renderer.onToolCall(step.id, step.label, toolKind, step.chip ?? "");
}

export interface RunFeed {
  /** Detach early (idempotent). Feeds also self-detach on run completion. */
  detach(): void;
}

/**
 * Attach `renderer` to run `runId`: bus steps → onToolCall/onThinking,
 * turn-stream deltas → onTextChunk, and the terminal `end` event → onDone (the
 * run's final status is passed as `stopReason`, letting a Renderer branch its
 * delivery). Finalization is idempotent, and a subscribe-then-recheck (mirroring
 * slack/watcher.ts) closes the race where a fast run finishes before we attach.
 * The feed detaches itself on completion.
 */
export function attachRunFeed(runId: string, renderer: Renderer): RunFeed {
  let settled = false;

  const unsubscribeDeltas = turnStream.subscribe(runId, (delta) => {
    void renderer.onTextChunk(delta);
  });

  const detach = (): void => {
    bus.off(runChannel(runId), onEvent);
    unsubscribeDeltas();
  };

  const finish = async (status: RunStatus): Promise<void> => {
    if (settled) return;
    settled = true;
    detach();
    // A renderer error must never break run completion.
    await Promise.resolve(renderer.onDone(status)).catch((err) => {
      console.error(`[connectors] renderer onDone failed for run ${runId}:`, err);
    });
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      void finish(ev.status);
      return;
    }
    if (ev.type === "step" && !settled) {
      try {
        feedStep(renderer, ev.step);
      } catch {
        /* a renderer mapping error never breaks the run */
      }
    }
  };

  void Promise.resolve(renderer.onTurnStart?.()).catch(() => {});
  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && (r.status === "completed" || r.status === "failed")) {
      void finish(r.status);
    }
  });

  return { detach };
}
