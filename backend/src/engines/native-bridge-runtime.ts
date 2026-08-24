import { NativeBridgeSequencer, type NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import { recordProviderEvent } from "../runs/provider-events";
import type { EngineRunContext } from "./types";
import { piBridgeProviderEvent } from "./pi-provider-events";

export interface NativeBridgeTurnSession {
  readonly sessionFile: string;
  subscribe(listener: (frame: unknown) => void): () => void;
}

export interface NativeBridgeTurnOptions {
  readonly ctx: EngineRunContext;
  readonly driver: ProviderDriver;
  readonly session: HarnessSession;
  readonly bridge: NativeBridgeTurnSession;
  readonly prompt: string;
  readonly mapFrame: (frame: unknown) => readonly NativeBridgeFrameBody[];
  readonly redact: (value: string) => string;
}

/** Shared turn runner for versioned native bridges. It owns ordering, durable
 * provider-frame persistence, streaming deltas, cancellation, and final settle;
 * provider adapters own only native-frame translation. */
export async function runNativeBridgeTurn(options: NativeBridgeTurnOptions): Promise<string> {
  const { ctx, driver, session, bridge } = options;
  const sequence = new NativeBridgeSequencer(session.nativeSessionId);
  let summary = "";
  let eventWrites = Promise.resolve();
  const { promise: settled, resolve: resolveSettled, reject: rejectSettled } = Promise.withResolvers<void>();
  const unsubscribe = bridge.subscribe((raw) => {
    for (const body of options.mapFrame(raw)) {
      const frame = sequence.frame(body);
      eventWrites = eventWrites.then(() => recordProviderEvent(
        piBridgeProviderEvent(ctx, frame),
        { critical: body.kind === "commands.updated" },
      ));
      if (body.kind === "message.delta") {
        const delta = options.redact(body.text);
        summary += delta;
        ctx.publishDelta?.(delta);
        ctx.reportActivity?.();
      } else if (body.kind === "reasoning.delta") {
        ctx.publishDelta?.(options.redact(body.text), "reasoning");
        ctx.reportActivity?.();
      } else if (body.kind === "turn.completed") {
        resolveSettled();
      }
    }
  });
  const onAbort = () => {
    void driver.cancel(session, "turn aborted").finally(() => rejectSettled(new Error("Run aborted")));
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
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
    await eventWrites;
    return summary;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}
