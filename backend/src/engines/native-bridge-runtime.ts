import {
  NativeBridgeDeltaAccumulator,
  NativeBridgeSequencer,
  type NativeBridgeFrameBody,
} from "@useagent/agent-harness/bridge";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import type { SecretRedactor } from "../secrets/redact";
import { recordProviderEvent } from "../runs/provider-events";
import type { ProviderEventInput } from "../runs/provider-events";
import { errorMessage } from "../util/error-message";
import type { EngineRunContext } from "./types";
import { piBridgeProviderEvent } from "./pi-provider-events";

export interface NativeBridgeTurnSession {
  readonly sessionFile: string;
  subscribe(listener: (frame: unknown) => void): () => void;
  reconcileCompletedChild?(frame: unknown): (() => Promise<readonly unknown[]>) | null;
}

export interface NativeBridgeTurnOptions {
  readonly ctx: EngineRunContext;
  readonly driver: ProviderDriver;
  readonly session: HarnessSession;
  readonly bridge: NativeBridgeTurnSession;
  readonly prompt: string;
  readonly mapFrame: (frame: unknown) => readonly NativeBridgeFrameBody[];
  readonly redact: Pick<SecretRedactor, "text" | "unknown">;
  /** Test seam for the bounded serialized child-transcript drain. */
  readonly childTranscriptDrainBudgetMs?: number;
}

const CHILD_TRANSCRIPT_DRAIN_BUDGET_MS = 15_000;
const NATIVE_CANCEL_TERMINAL_GRACE_MS = 5_000;

function transcriptOutcome(
  bodies: readonly NativeBridgeFrameBody[],
  status: "complete" | "failed",
  error?: string,
): readonly NativeBridgeFrameBody[] {
  return bodies.map((body) => body.kind === "child.completed"
    ? {
        ...body,
        transcript: { status, ...(error ? { error } : {}) },
      }
    : body);
}

export function safePiBridgeProviderEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  frame: Parameters<typeof piBridgeProviderEvent>[1],
  redact: Pick<SecretRedactor, "unknown">,
): ProviderEventInput {
  const event = piBridgeProviderEvent(ctx, frame);
  return { ...event, payload: redact.unknown(event.payload) };
}

export function nativeBridgeSettlement(
  body: NativeBridgeFrameBody,
): { readonly status: "completed" } | { readonly status: "failed"; readonly error: string } | null {
  if (body.ownerChildId) return null;
  if (body.kind === "turn.completed") return { status: "completed" };
  if (body.kind === "turn.failed") return { status: "failed", error: body.error };
  return null;
}

/** Shared turn runner for versioned native bridges. It owns ordering, durable
 * provider-frame persistence, streaming deltas, cancellation, and final settle;
 * provider adapters own only native-frame translation. */
export async function runNativeBridgeTurn(
  options: NativeBridgeTurnOptions,
  persistEvent: typeof recordProviderEvent = recordProviderEvent,
): Promise<string> {
  const { ctx, driver, session, bridge } = options;
  const sequence = new NativeBridgeSequencer(session.nativeSessionId);
  const durableDeltas = new NativeBridgeDeltaAccumulator();
  let summary = "";
  let authoritativeSummary: string | null = null;
  let childTranscriptDeadline: number | null = null;
  const childTranscriptDrainBudgetMs = options.childTranscriptDrainBudgetMs ??
    CHILD_TRANSCRIPT_DRAIN_BUDGET_MS;
  let eventWrites = Promise.resolve();
  const persistBodies = async (
    bodies: readonly NativeBridgeFrameBody[],
    required = false,
  ): Promise<void> => {
    for (const body of bodies) {
      for (const durableBody of durableDeltas.durable(body)) {
        const frame = sequence.frame(durableBody);
        await persistEvent(
          safePiBridgeProviderEvent(ctx, frame, options.redact),
          {
            critical: body.kind === "commands.updated" || required || Boolean(body.ownerChildId),
            required: required || Boolean(body.ownerChildId),
          },
        );
      }
    }
  };
  const observeBody = (body: NativeBridgeFrameBody): void => {
    if (body.ownerChildId) {
      ctx.reportActivity?.();
    } else if (body.kind === "message.delta") {
      const delta = options.redact.text(body.text);
      summary += delta;
      ctx.publishDelta?.(delta);
      ctx.reportActivity?.();
    } else if (body.kind === "message.authoritative") {
      authoritativeSummary = options.redact.text(body.text);
    } else if (body.kind === "reasoning.delta") {
      ctx.publishDelta?.(options.redact.text(body.text), "reasoning");
      ctx.reportActivity?.();
    } else {
      const settlement = nativeBridgeSettlement(body);
      if (settlement?.status === "completed") resolveSettled();
      else if (settlement?.status === "failed") {
        rejectSettled(new Error(options.redact.text(settlement.error)));
      }
    }
  };
  const { promise: settled, resolve: resolveSettled, reject: rejectSettled } = Promise.withResolvers<void>();
  const unsubscribe = bridge.subscribe((raw) => {
    const bodies = options.mapFrame(raw);
    for (const body of bodies) observeBody(body);
    const reconciliation = bridge.reconcileCompletedChild?.(raw);
    if (reconciliation) {
      eventWrites = eventWrites.then(async () => {
        let completionBodies = bodies;
        try {
          childTranscriptDeadline ??= Date.now() + childTranscriptDrainBudgetMs;
          const remainingMs = childTranscriptDeadline - Date.now();
          if (remainingMs <= 0) {
            throw new Error("child transcript drain budget exhausted");
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const replayFrames = await Promise.race([
            reconciliation(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("child transcript drain budget exhausted")),
                remainingMs,
              );
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          for (const replayFrame of replayFrames) {
            await persistBodies(options.mapFrame(replayFrame), true);
          }
          completionBodies = transcriptOutcome(bodies, "complete");
        } catch (error) {
          const safeError = options.redact.text(errorMessage(error));
          console.warn("[native-bridge] child transcript reconciliation failed", {
            runId: ctx.runId,
            error: safeError,
          });
          completionBodies = transcriptOutcome(bodies, "failed", safeError);
        }
        await persistBodies(completionBodies, true);
      });
    } else {
      eventWrites = eventWrites.then(() => persistBodies(bodies));
    }
  });
  let listening = true;
  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    unsubscribe();
  };
  const onAbort = () => {
    void driver.cancel(session, "turn aborted").then(
      (result) => {
        if (result.status !== "ok") {
          rejectSettled(new Error(options.redact.text(
            result.message ?? `Native cancel failed (${result.status})`,
          )));
          return;
        }
        const timer = setTimeout(
          () => rejectSettled(new Error("Native cancel produced no terminal provider evidence")),
          NATIVE_CANCEL_TERMINAL_GRACE_MS,
        );
        timer.unref?.();
        void settled.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      },
      (cause) => rejectSettled(new Error(options.redact.text(errorMessage(cause)))),
    );
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    let operationError: unknown;
    try {
      ctx.signal.throwIfAborted();
      const result = await driver.steer({
        runId: ctx.runId,
        threadId: ctx.threadId ?? ctx.runId,
        session,
        input: { kind: "prompt", text: options.prompt, model: ctx.model },
        signal: ctx.signal,
      });
      if (result.status !== "ok") {
        throw new Error(`Pi steer failed (${result.status}): ${result.message ?? "unsupported"}`);
      }
      await settled;
    } catch (error) {
      operationError = error;
    }
    stopListening();
    let persistenceError: unknown;
    try {
      await eventWrites;
    } catch (error) {
      persistenceError = error;
    }
    if (operationError && persistenceError) {
      throw new AggregateError(
        [operationError, persistenceError],
        "Pi turn and durable provider-event drain both failed",
      );
    }
    if (persistenceError) throw persistenceError;
    if (operationError) throw operationError;
    return authoritativeSummary ?? summary;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    stopListening();
  }
}
