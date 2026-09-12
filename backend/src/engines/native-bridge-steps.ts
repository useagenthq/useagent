import type { NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";
import type { SecretRedactor } from "../secrets/redact";
import { toolStep } from "./tool-step";
import type { EngineRunContext } from "./types";

const OUTPUT_CAP = 2_000;

interface EmittedToolStep {
  readonly id: string | undefined;
  readonly code: Record<string, unknown>;
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Project a native bridge's tool frames onto the durable step lane. A
 * `command` or `file` row is emitted the moment a tool starts (so a running
 * command is visible and Stop can see a turn mid-flight) and enriched in place
 * with its output when the tool completes, exactly as the opencode adapter
 * does for its parts. Child-owned tool frames stay on the child transcript.
 * Emits are serialized so step order matches frame order. */
export function createNativeBridgeStepProjector(
  ctx: Pick<EngineRunContext, "emit" | "updateStep">,
  redact: Pick<SecretRedactor, "text" | "unknown">,
): {
  observe(body: NativeBridgeFrameBody): void;
  drain(): Promise<void>;
} {
  const emitted = new Map<string, Promise<EmittedToolStep>>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    observe(body) {
      if (body.ownerChildId) return;
      if (body.kind === "tool.started") {
        // Pi announces one call twice (the assistant message's toolCall block and
        // the execution start); one row per call id, the first announcement wins.
        if (emitted.has(body.toolCallId)) return;
        const step = toolStep(body.name, inputRecord(redact.unknown(body.input)), undefined, undefined);
        const pending = chain.then(async () => ({
          id: await ctx.emit(step),
          code: step.code_json as Record<string, unknown>,
        }));
        emitted.set(body.toolCallId, pending);
        chain = pending;
        return;
      }
      if (body.kind !== "tool.completed") return;
      const pending = emitted.get(body.toolCallId);
      if (!pending) return;
      emitted.delete(body.toolCallId);
      chain = chain.then(async () => {
        const { id, code } = await pending;
        if (!id) return;
        await ctx.updateStep?.(id, {
          ...code,
          output: redact.text(body.error ?? body.preview ?? "").slice(0, OUTPUT_CAP),
          error: body.status === "error",
        });
      });
    },
    drain() {
      return chain.then(() => undefined);
    },
  };
}
