import { createSecretRedactor, type SecretRedactor } from "../secrets/redact";
import { errorMessage } from "../util/error-message";
import type { EngineRunContext } from "./types";

export { createSecretRedactor };
export type { SecretRedactor };

/** Apply one redactor at the CLI engine boundary before output is persisted. */
export function withSandboxOutputRedaction(
  ctx: EngineRunContext,
  redact: SecretRedactor,
): EngineRunContext {
  return {
    ...ctx,
    emit: (step) => ctx.emit(redact.unknown(step)),
    updateStep: ctx.updateStep
      ? (stepId, code) => ctx.updateStep!(stepId, redact.unknown(code))
      : undefined,
    publishDelta: ctx.publishDelta
      ? (delta, kind) => ctx.publishDelta!(redact.text(delta), kind)
      : undefined,
    setSummary: (summary, durationMs) => ctx.setSummary(redact.text(summary), durationMs),
  };
}

/** Format a CLI exit failure without allowing its raw output tail to escape. */
export function sandboxExitError(
  engine: "claude" | "codex",
  exitCode: number,
  rawTail: string,
  redact: SecretRedactor,
): Error {
  return new Error(
    redact.text(`${engine} (in sandbox) exited ${exitCode}: ${rawTail || "no output"}`),
  );
}

export function redactSandboxError(error: unknown, redact: SecretRedactor): Error {
  const safe = new Error(redact.text(errorMessage(error)));
  if (error instanceof Error) safe.name = error.name;
  return safe;
}
