import { describe, expect, test } from "bun:test";
import { MAX_FLEET_TASKS } from "@useagent/agent-client/fleet";
import { CliError } from "../src/errors";
import { parseTasksJsonl, serializeResults } from "../src/jsonl";

describe("parseTasksJsonl", () => {
  test("parses task lines, skipping blanks, carrying optional fields", () => {
    const text = [
      '{"prompt":"a"}',
      "",
      '{"prompt":"b","engine":"codex","model":"m","repos":["o/r"]}',
      "   ",
    ].join("\n");
    const tasks = parseTasksJsonl(text);
    expect(tasks).toEqual([
      { prompt: "a" },
      { prompt: "b", engine: "codex", model: "m", repos: ["o/r"] },
    ]);
  });

  test("ignores non-string optional fields rather than trusting them", () => {
    const [task] = parseTasksJsonl('{"prompt":"a","engine":5,"repos":[1,"o/r"]}');
    expect(task).toEqual({ prompt: "a" });
  });

  test("reports the offending line number for invalid JSON", () => {
    expect(() => parseTasksJsonl('{"prompt":"a"}\nnot json')).toThrow(/line 2: not valid JSON/);
  });

  test("requires a non-empty prompt per line", () => {
    expect(() => parseTasksJsonl('{"prompt":""}')).toThrow(/line 1:.*prompt/);
    expect(() => parseTasksJsonl('{"nope":1}')).toThrow(/line 1:.*prompt/);
    expect(() => parseTasksJsonl("[1,2]")).toThrow(/line 1:.*prompt/);
  });

  test("throws when there are no task lines at all", () => {
    expect(() => parseTasksJsonl("\n  \n")).toThrow(CliError);
    expect(() => parseTasksJsonl("\n  \n")).toThrow(/no task lines/);
  });

  test("rejects a batch above the shared fleet task limit", () => {
    const input = Array.from(
      { length: MAX_FLEET_TASKS + 1 },
      (_, index) => JSON.stringify({ prompt: `task-${index}` }),
    ).join("\n");
    expect(() => parseTasksJsonl(input)).toThrow(`at most ${MAX_FLEET_TASKS} tasks`);
  });
});

describe("serializeResults", () => {
  test("emits one newline-terminated JSON object per result", () => {
    const out = serializeResults([
      { prompt: "a", runId: "r1", status: "completed", answer: "ok", url: "u1" },
      { prompt: "b", runId: null, status: "dispatch_error", answer: "", url: null, error: "boom" },
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ runId: "r1", status: "completed" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ status: "dispatch_error", error: "boom" });
    expect(out.endsWith("\n")).toBe(true);
  });
});
