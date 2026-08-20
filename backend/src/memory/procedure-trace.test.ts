// Pure tests for the learning-lane procedure trace: the ordered, bounded,
// redacted executable trace a knowledge draft carries so an accepted learning
// can assemble a real playbook. The DB path (steps read at draft time) is
// proven in test/knowledge-drafts.test.ts.
import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import {
  buildProcedureTrace,
  MAX_GIST_CHARS,
  MAX_TRACE_STEPS,
  type TraceSourceStep,
} from "./procedure-trace";

const noSecrets = createSecretRedactor([]);

function commandRow(command: string, extra: Record<string, unknown> = {}): TraceSourceStep {
  return {
    kind: "command",
    label: command.slice(0, 60),
    chip: "bash",
    codeJson: JSON.stringify({ tool: "bash", input: { command }, ...extra }),
  };
}

describe("buildProcedureTrace", () => {
  test("keeps the row order, reads tool + target from the step payload, excludes the done marker", () => {
    const rows: TraceSourceStep[] = [
      commandRow("bun install"),
      {
        kind: "file",
        label: "config.ts",
        chip: "file",
        codeJson: JSON.stringify({ tool: "edit", input: { filePath: "src/config.ts" } }),
      },
      {
        kind: "task",
        label: "Subagent - review the diff",
        chip: "subagent",
        codeJson: JSON.stringify({ tool: "task", input: { description: "review the diff" } }),
      },
      { kind: "done", label: "Done", chip: null, codeJson: null },
    ];
    expect(buildProcedureTrace(rows, noSecrets)).toEqual({
      steps: [
        { tool: "bash", gist: "bun install", ok: true },
        { tool: "edit", gist: "src/config.ts", ok: true },
        { tool: "task", gist: "review the diff", ok: true },
      ],
      elided: 0,
    });
  });

  test("a failed tool is recorded honestly (error flag or failed status)", () => {
    const rows = [
      commandRow("bun test", { error: true }),
      commandRow("gh pr view 123", { status: "failed" }),
      commandRow("bun run typecheck"),
    ];
    expect(buildProcedureTrace(rows, noSecrets).steps.map((s) => s.ok)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("gists are redacted: injected secret values and bare JWTs never survive", () => {
    const secret = "sk-live-payments-key-9000";
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const redact = createSecretRedactor([secret]);
    const rows = [commandRow(`curl -H "Authorization: Bearer ${secret}" https://api.example.com`), commandRow(`echo ${jwt}`)];
    const { steps } = buildProcedureTrace(rows, redact);
    expect(steps[0]!.gist).not.toContain(secret);
    expect(steps[0]!.gist).toContain("<redacted>");
    expect(steps[1]!.gist).toBe("echo <redacted>");
  });

  test("hard bounds: at most MAX_TRACE_STEPS entries, elisions counted, gists capped to one line", () => {
    const rows = Array.from({ length: MAX_TRACE_STEPS + 12 }, (_, i) =>
      commandRow(`step ${i}\n  with a second line and ${"x".repeat(400)}`),
    );
    const trace = buildProcedureTrace(rows, noSecrets);
    expect(trace.steps).toHaveLength(MAX_TRACE_STEPS);
    expect(trace.elided).toBe(12);
    // First 40 kept in order; the tail is what gets elided.
    expect(trace.steps[0]!.gist.startsWith("step 0 ")).toBe(true);
    for (const step of trace.steps) {
      expect(step.gist.length).toBeLessThanOrEqual(MAX_GIST_CHARS);
      expect(step.gist).not.toContain("\n");
    }
  });

  test("legacy rows without payloads fall back to chip/kind + label and never throw", () => {
    const rows: TraceSourceStep[] = [
      { kind: "command", label: "step 0", chip: null, codeJson: null },
      { kind: "file", label: "README.md", chip: "file", codeJson: "{not json" },
    ];
    expect(buildProcedureTrace(rows, noSecrets)).toEqual({
      steps: [
        { tool: "command", gist: "step 0", ok: true },
        { tool: "file", gist: "README.md", ok: true },
      ],
      elided: 0,
    });
  });

  test("deterministic: same rows, same trace", () => {
    const rows = [commandRow("bun install"), commandRow("bun test")];
    expect(buildProcedureTrace(rows, noSecrets)).toEqual(buildProcedureTrace(rows, noSecrets));
  });
});
