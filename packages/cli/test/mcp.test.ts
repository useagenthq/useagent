import { describe, expect, test } from "bun:test";
import { MAX_FLEET_CONCURRENCY, MAX_FLEET_TASKS } from "@useagent/agent-client/fleet";
import { FLEET_TOOLS, handleToolCall } from "../src/mcp";
import { fakeClient, makeSummary } from "./fake-client";

function payload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text);
}

describe("FLEET_TOOLS", () => {
  test("advertises the four fleet tools with object input schemas", () => {
    expect(FLEET_TOOLS.map((t) => t.name)).toEqual([
      "dispatch_task",
      "dispatch_parallel",
      "get_run_result",
      "list_recent_runs",
    ]);
    for (const tool of FLEET_TOOLS) expect(tool.inputSchema.type).toBe("object");
  });
});

describe("handleToolCall", () => {
  test("dispatch_task returns the run id, or errors on a missing prompt", async () => {
    const ok = await handleToolCall(fakeClient(), "dispatch_task", { prompt: "hi" });
    expect(ok.isError).toBeUndefined();
    expect(payload(ok)).toMatchObject({ runId: "run_x", status: "queued" });

    const bad = await handleToolCall(fakeClient(), "dispatch_task", { prompt: "  " });
    expect(bad.isError).toBe(true);
  });

  test("dispatch_parallel returns run ids immediately and echoes qc", async () => {
    const result = await handleToolCall(fakeClient(), "dispatch_parallel", {
      tasks: [{ prompt: "a" }, { prompt: "b" }],
      concurrency: 2,
      qc: "check",
    });
    const data = payload(result) as { runs: unknown[]; qc: string };
    expect(data.runs).toHaveLength(2);
    expect(data.qc).toBe("check");
  });

  test("dispatch_parallel errors on a non-array or a bad task", async () => {
    expect((await handleToolCall(fakeClient(), "dispatch_parallel", {})).isError).toBe(true);
    expect((await handleToolCall(fakeClient(), "dispatch_parallel", { tasks: [{ nope: 1 }] })).isError).toBe(true);
  });

  test("dispatch_parallel rejects oversized batches and invalid concurrency", async () => {
    const tasks = Array.from({ length: MAX_FLEET_TASKS + 1 }, (_, index) => ({
      prompt: `task-${index}`,
    }));
    expect(
      (await handleToolCall(fakeClient(), "dispatch_parallel", { tasks })).isError,
    ).toBe(true);
    expect(
      (
        await handleToolCall(fakeClient(), "dispatch_parallel", {
          tasks: [{ prompt: "one" }],
          concurrency: MAX_FLEET_CONCURRENCY + 1,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await handleToolCall(fakeClient(), "dispatch_parallel", {
          tasks: [{ prompt: "one" }],
          concurrency: 1.5,
        })
      ).isError,
    ).toBe(true);
  });

  test("get_run_result settles and, with qc, adds a verdict", async () => {
    const plain = await handleToolCall(fakeClient(), "get_run_result", { runId: "run_1" });
    expect(payload(plain)).toMatchObject({ runId: "run_1", status: "completed", answer: "done" });
    expect(payload(plain)).not.toHaveProperty("verdict");

    const verified = await handleToolCall(fakeClient(), "get_run_result", { runId: "run_1", qc: "ok?" });
    expect(payload(verified)).toMatchObject({ verdict: "pass", status: "completed" });
  });

  test("get_run_result errors without a runId", async () => {
    expect((await handleToolCall(fakeClient(), "get_run_result", {})).isError).toBe(true);
  });

  test("list_recent_runs maps summaries to compact rows", async () => {
    const client = fakeClient({ listRecent: async () => [makeSummary({ id: "run_a", status: "completed" })] });
    const rows = payload(await handleToolCall(client, "list_recent_runs", { limit: 5 })) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ runId: "run_a", status: "completed", url: "https://fleet.test/session/run_a" });
  });

  test("an unknown tool is a tool error, not a throw", async () => {
    expect((await handleToolCall(fakeClient(), "nope", {})).isError).toBe(true);
  });
});
