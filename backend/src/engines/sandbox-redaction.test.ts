import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import { sandboxExitError, withSandboxOutputRedaction } from "./sandbox";
import type { EmitStep, EngineRunContext } from "./types";

const SECRET = "CLI_SYNTHETIC_SECRET_MARKER_9f1c2d";

function contextRecorder() {
  const steps: EmitStep[] = [];
  const updates: unknown[] = [];
  const deltas: string[] = [];
  const summaries: string[] = [];
  const ctx = {
    runId: "run-redaction",
    prompt: "test",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/tmp/test",
    signal: new AbortController().signal,
    emit: async (step: EmitStep) => {
      steps.push(step);
      return "step-1";
    },
    updateStep: async (_stepId: string, code: unknown) => {
      updates.push(code);
    },
    publishDelta: (delta: string) => {
      deltas.push(delta);
    },
    setSummary: (summary: string) => {
      summaries.push(summary);
    },
  } satisfies EngineRunContext;
  return { ctx, steps, updates, deltas, summaries };
}

describe("CLI sandbox output redaction", () => {
  test("redacts synthetic markers from steps, updates, deltas, and final summary", async () => {
    const recorded = contextRecorder();
    const ctx = withSandboxOutputRedaction(
      recorded.ctx,
      createSecretRedactor([SECRET]),
    );

    await ctx.emit({
      kind: "command",
      label: `used ${SECRET}`,
      code_json: { input: { token: SECRET }, output: `tail ${SECRET}` },
    });
    await ctx.updateStep?.("step-1", { nested: [`result ${SECRET}`] });
    ctx.publishDelta?.(`delta ${SECRET}`);
    ctx.setSummary(`summary ${SECRET}`, 12);

    const serialized = JSON.stringify({
      steps: recorded.steps,
      updates: recorded.updates,
      deltas: recorded.deltas,
      summaries: recorded.summaries,
    });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("<redacted>");
  });

  test("redacts synthetic markers from CLI error tails", () => {
    const error = sandboxExitError(
      "codex",
      1,
      `authentication failed for ${SECRET}`,
      createSecretRedactor([SECRET]),
    );

    expect(error.message).toBe("codex (in sandbox) exited 1: authentication failed for <redacted>");
    expect(error.message).not.toContain(SECRET);
  });
});
