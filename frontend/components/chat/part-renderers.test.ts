// Slice-2 renderer logic: native error state + typed todo parsing (Phase 5).
// Run: `bun test components/chat/part-renderers.test.ts` (from frontend/).

import { describe, expect, test } from "bun:test";
import { deriveTrace, parseTodos } from "./types";
import type { ApiStep, StepKind } from "./types";

let seq = 0;
function step(
  kind: StepKind,
  label: string,
  code: Record<string, unknown> | null,
  chip: string | null = null,
): ApiStep {
  return {
    id: `st_${seq++}`,
    run_id: "run-1",
    idx: seq,
    kind,
    label,
    chip,
    code_json: code ? JSON.stringify(code) : null,
    created_at: new Date(0).toISOString(),
  };
}

describe("deriveTrace — native error state", () => {
  test("native tool error (code_json.error) flags isError with no exit code", () => {
    const t = deriveTrace(
      step("command", "read", { tool: "read", input: { file_path: "/x/gone.txt" }, output: "ENOENT", error: true }),
    );
    expect(t.isError).toBe(true);
    expect(t.exitCode).toBeNull(); // read has no exit — the flag is the only signal
  });

  test("non-zero command exit flags isError", () => {
    const t = deriveTrace(
      step("command", "bash", { tool: "bash", input: { command: "exit 7" }, exit_code: 7 }),
    );
    expect(t.isError).toBe(true);
    expect(t.exitCode).toBe(7);
  });

  test("successful tool is not an error", () => {
    const t = deriveTrace(
      step("command", "bash", { tool: "bash", input: { command: "ls" }, output: "a\nb", exit_code: 0 }),
    );
    expect(t.isError).toBe(false);
  });

  test("errored file write inherits the native flag", () => {
    const t = deriveTrace(
      step("file", "write", { tool: "write", input: { file_path: "/ro/x.txt" }, error: true }),
    );
    expect(t.isError).toBe(true);
  });

  test("richer tool taxonomy: skill/question/apply_patch resolve real verbs", () => {
    expect(deriveTrace(step("command", "skill", { tool: "skill", input: { name: "deploy" } })).verb).toBe("Skill");
    expect(deriveTrace(step("command", "question", { tool: "question", input: {} })).verb).toBe("Question");
    expect(deriveTrace(step("file", "apply_patch", { tool: "apply_patch", input: { file_path: "a.ts" } })).verb).toBe("Edit");
  });
});

describe("parseTodos", () => {
  test("parses a todowrite plan into typed items", () => {
    const todos = parseTodos(
      step("command", "todowrite", {
        tool: "todowrite",
        input: {
          todos: [
            { content: "Scaffold", status: "completed" },
            { content: "Wire API", status: "in_progress" },
            { content: "Tests", status: "pending" },
            { content: "Drop dead code", status: "cancelled" },
          ],
        },
      }),
    );
    expect(todos).not.toBeNull();
    expect(todos!.map((t) => t.status)).toEqual(["completed", "in_progress", "pending", "cancelled"]);
    expect(todos![0].id).toBe("0-Scaffold");
    expect(todos![0].content).toBe("Scaffold");
  });

  test("unknown status normalizes to pending; empty/absent → null", () => {
    expect(parseTodos(step("command", "todowrite", { tool: "todowrite", input: { todos: [{ content: "X", status: "weird" }] } }))![0].status).toBe("pending");
    expect(parseTodos(step("command", "todowrite", { tool: "todowrite", input: { todos: [] } }))).toBeNull();
    expect(parseTodos(step("command", "bash", { tool: "bash", input: { command: "ls" } }))).toBeNull();
  });
});
