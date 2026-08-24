import { describe, expect, test } from "bun:test";
import { fanCommand, runCommand, statusCommand, type CommandIO } from "../src/commands";
import { fakeClient, makeApiRun } from "./fake-client";

function captureIO(files: Record<string, string> = {}): CommandIO & { stdout: string[]; stderr: string[]; written: Record<string, string> } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: Record<string, string> = {};
  return {
    stdout,
    stderr,
    written,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    readFile: async (path) => {
      const data = files[path];
      if (data === undefined) throw new Error(`no such file: ${path}`);
      return data;
    },
    writeFile: async (path, data) => {
      written[path] = data;
    },
  };
}

describe("runCommand", () => {
  test("prints the run id + url and returns 0 without --watch", async () => {
    const io = captureIO();
    const code = await runCommand(fakeClient(), { prompt: "hi", repos: [], watch: false }, io);
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["run run_x", "https://fleet.test/session/run_x"]);
  });

  test("with --watch streams status lines then the final answer", async () => {
    const io = captureIO();
    const client = fakeClient({
      awaitSettled: async (runId, options) => {
        options?.onPoll?.(makeApiRun({ id: runId, status: "running" }));
        return { runId, status: "completed", run: makeApiRun({ id: runId, status: "completed", summary: "the answer" }), answer: "the answer", url: `https://fleet.test/session/${runId}` };
      },
    });
    const code = await runCommand(client, { prompt: "hi", repos: [], watch: true }, io);
    expect(code).toBe(0);
    expect(io.stderr).toContain("... running");
    expect(io.stderr).toContain("status: completed");
    expect(io.stdout).toContain("the answer");
  });
});

describe("statusCommand", () => {
  test("prints status + url + answer for a known run", async () => {
    const io = captureIO();
    const code = await statusCommand(fakeClient(), { runId: "run_7" }, io);
    expect(code).toBe(0);
    expect(io.stderr).toContain("status: completed");
    expect(io.stdout).toContain("https://fleet.test/session/run_7");
    expect(io.stdout).toContain("done");
  });

  test("returns 1 for an unknown run", async () => {
    const io = captureIO();
    const client = fakeClient({ getRun: async (runId) => ({ runId, status: "unknown", run: null, answer: "", url: "u" }) });
    expect(await statusCommand(client, { runId: "missing" }, io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("not found");
  });
});

describe("fanCommand", () => {
  const tasksFile = { "tasks.jsonl": '{"prompt":"a"}\n{"prompt":"b"}\n' };

  test("dispatches, settles, writes JSONL to --out, and prints a summary", async () => {
    const io = captureIO(tasksFile);
    const code = await fanCommand(fakeClient(), { file: "tasks.jsonl", parallel: 4, out: "results.jsonl" }, io);
    expect(code).toBe(0);
    const lines = io.written["results.jsonl"]!.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ prompt: "a", status: "completed" });
    expect(io.stderr.join("\n")).toContain("2 task(s):");
  });

  test("with --qc records a verdict per task", async () => {
    const io = captureIO(tasksFile);
    const code = await fanCommand(fakeClient(), { file: "tasks.jsonl", parallel: 2, qc: "check it" }, io);
    expect(code).toBe(0);
    const printed = io.stdout.join("\n").trimEnd().split("\n");
    expect(JSON.parse(printed[0]!)).toMatchObject({ verdict: "pass" });
  });

  test("isolates a dispatch failure and returns exit 1", async () => {
    const io = captureIO(tasksFile);
    const client = fakeClient({
      dispatchMany: async (tasks) => [
        { ok: true, task: tasks[0]!, run: { runId: "run_0", status: "queued", url: "u0" } },
        { ok: false, task: tasks[1]!, error: "GET /api/runs -> HTTP 500" },
      ],
    });
    const code = await fanCommand(client, { file: "tasks.jsonl", parallel: 2 }, io);
    expect(code).toBe(1);
    const printed = io.stdout.join("\n").trimEnd().split("\n");
    expect(JSON.parse(printed[1]!)).toMatchObject({ status: "dispatch_error", error: "GET /api/runs -> HTTP 500" });
  });

  test("preserves every result when one settle call fails", async () => {
    const io = captureIO(tasksFile);
    const client = fakeClient({
      awaitSettled: async (runId) => {
        if (runId === "run_1") throw new Error("poll failed");
        return {
          runId,
          status: "completed",
          run: null,
          answer: "done",
          url: `https://fleet.test/session/${runId}`,
        };
      },
    });
    const code = await fanCommand(client, { file: "tasks.jsonl", parallel: 2 }, io);
    expect(code).toBe(1);
    const rows = io.stdout.join("\n").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "completed", answer: "done" });
    expect(rows[1]).toMatchObject({ status: "settle_error", error: "poll failed" });
  });

  test("preserves completed work when verification fails", async () => {
    const io = captureIO(tasksFile);
    const client = fakeClient({ verify: async () => { throw new Error("verifier unavailable"); } });
    const code = await fanCommand(
      client,
      { file: "tasks.jsonl", parallel: 2, qc: "verify" },
      io,
    );
    expect(code).toBe(1);
    const rows = io.stdout.join("\n").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "verification_error",
      answer: "done",
      verdict: "unknown",
      error: "verifier unavailable",
    });
  });
});
