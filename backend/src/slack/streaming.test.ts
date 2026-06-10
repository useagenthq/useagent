/**
 * Pure streaming-grammar tests: no I/O, fixtures only. The chunk shapes here ARE
 * the documented wire contract of chat.startStream/appendStream/stopStream
 * (flat task_update with id/title/status, plan_update with title, markdown_text
 * with text) - a drift in these shapes is exactly the bug that made live Slack
 * reject every stream and silently fall back to the plain card.
 */
import { describe, expect, test } from "bun:test";
import {
  composeStreamClosing,
  createNarrationBuffer,
  directMessageChannel,
  markdownChunksFor,
  openingStreamChunks,
  planUpdateFromStep,
  runningTaskChunk,
  statusTextForStep,
  stepProgressChunks,
  taskUpdateChunk,
  terminalTaskChunks,
} from "./streaming";

describe("wire chunk shapes (documented contract)", () => {
  test("task_update is FLAT: id/title/status at the top level, no nesting", () => {
    const chunk = taskUpdateChunk({ id: "step_1", title: "Cloning repo", status: "in_progress" });
    expect(chunk).toEqual({
      type: "task_update",
      id: "step_1",
      title: "Cloning repo",
      status: "in_progress",
    });
    expect("task" in chunk).toBe(false);
    expect("task_id" in chunk).toBe(false);
  });

  test("markdown chunks carry `text` (not `markdown_text`) and never mutate content", () => {
    const [chunk] = markdownChunksFor("Hello **world**");
    expect(chunk).toEqual({ type: "markdown_text", text: "Hello **world**" });
  });

  test("markdownChunksFor splits long text exactly, preserving every char", () => {
    const text = "x".repeat(25_000);
    const chunks = markdownChunksFor(text);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(markdownChunksFor("")).toEqual([]);
  });

  test("task titles cap under Slack's 256-char limit", () => {
    const chunk = taskUpdateChunk({ id: "t", title: "y".repeat(400), status: "complete" });
    expect(chunk.title.length).toBeLessThanOrEqual(250);
    expect(chunk.title.endsWith("…")).toBe(true);
  });

  test("the opening is one spinning root task - no throwaway markdown in the body", () => {
    const chunks = openingStreamChunks("Build the thing");
    expect(chunks).toEqual([
      { type: "task_update", id: "run", title: "Build the thing", status: "in_progress" },
    ]);
  });
});

describe("stepProgressChunks (start/complete pairing)", () => {
  test("the first step starts its task only", () => {
    const { chunks, next } = stepProgressChunks(null, { id: "s1", label: "Cloning repo" });
    expect(chunks).toEqual([
      { type: "task_update", id: "step_s1", title: "Cloning repo", status: "in_progress" },
    ]);
    expect(next).toEqual({ id: "s1", label: "Cloning repo" });
  });

  test("a NEW step completes the previous task and starts its own", () => {
    const { chunks } = stepProgressChunks({ id: "s1", label: "Cloning repo" }, { id: "s2", label: "Running tests" });
    expect(chunks).toEqual([
      { type: "task_update", id: "step_s1", title: "Cloning repo", status: "complete" },
      { type: "task_update", id: "step_s2", title: "Running tests", status: "in_progress" },
    ]);
  });

  test("an in-place enrichment of the SAME step never completes itself", () => {
    const { chunks } = stepProgressChunks({ id: "s1", label: "Cloning repo" }, { id: "s1", label: "Cloning repo (done)" });
    expect(chunks).toEqual([
      { type: "task_update", id: "step_s1", title: "Cloning repo (done)", status: "in_progress" },
    ]);
  });

  test("runningTaskChunk namespaces the step id", () => {
    expect(runningTaskChunk({ id: "abc", label: "Editing" }).id).toBe("step_abc");
  });
});

describe("planUpdateFromStep", () => {
  const planStep = (todos: unknown) => ({
    label: "Update plan",
    chip: "plan",
    codeJson: JSON.stringify({ tool: "todowrite", input: { todos } }),
  });

  test("a todos step becomes ONE plan_update titled with live progress", () => {
    const chunk = planUpdateFromStep(
      planStep([
        { content: "Inspect request", status: "completed" },
        { content: "Make changes", status: "in_progress" },
        { content: "Verify", status: "pending" },
      ]),
    );
    expect(chunk).toEqual({ type: "plan_update", title: "Plan 1/3: Make changes" });
  });

  test("a todowrite step without the plan chip still counts (engine variance)", () => {
    const chunk = planUpdateFromStep({
      label: "todos",
      chip: null,
      codeJson: JSON.stringify({ tool: "todowrite", input: { todos: [{ content: "A", status: "pending" }] } }),
    });
    expect(chunk?.type).toBe("plan_update");
  });

  test("a plan-chip step with unparseable/missing todos falls back to its label", () => {
    expect(planUpdateFromStep({ label: "Plan updated", chip: "plan", codeJson: "{not json" })).toEqual({
      type: "plan_update",
      title: "Plan updated",
    });
  });

  test("a non-plan step yields nothing", () => {
    expect(planUpdateFromStep({ label: "bash", chip: "tool", codeJson: JSON.stringify({ tool: "bash" }) })).toBeNull();
  });
});

describe("terminalTaskChunks", () => {
  test("completes the last tool task and the root task", () => {
    const chunks = terminalTaskChunks({
      phase: "completed",
      title: "Build the thing",
      lastStep: { id: "s9", label: "Final checks" },
    });
    expect(chunks).toEqual([
      { type: "task_update", id: "step_s9", title: "Final checks", status: "complete" },
      { type: "task_update", id: "run", title: "Build the thing", status: "complete" },
    ]);
  });

  test("a failed run settles its tasks as error", () => {
    const chunks = terminalTaskChunks({ phase: "failed", title: "Build", lastStep: null });
    expect(chunks).toEqual([{ type: "task_update", id: "run", title: "Run failed", status: "error" }]);
  });
});

describe("composeStreamClosing (answer never lost, never grossly duplicated)", () => {
  test("no narration: the closing IS the reply", () => {
    expect(composeStreamClosing({ status: "completed", summary: "The answer.", narration: "" })).toBe("The answer.");
    expect(composeStreamClosing({ status: "completed", summary: "  ", narration: "" })).toBe("Done.");
  });

  test("narration containing the reply closes with nothing (no duplication)", () => {
    expect(
      composeStreamClosing({
        status: "completed",
        summary: "The answer.",
        narration: "Working through it...\n\nThe answer.",
      }),
    ).toBe("");
  });

  test("narration NOT containing the reply re-states it (correctness first)", () => {
    expect(
      composeStreamClosing({ status: "completed", summary: "The answer.", narration: "partial narr" }),
    ).toBe("\n\nThe answer.");
  });

  test("a failed run always appends the failure line", () => {
    expect(composeStreamClosing({ status: "failed", summary: "boom", narration: "" })).toBe("**Run failed**: boom");
    expect(composeStreamClosing({ status: "failed", summary: "boom", narration: "some text" })).toBe(
      "\n\n**Run failed**: boom",
    );
  });
});

describe("createNarrationBuffer (exact offsets, total cap)", () => {
  test("segments drain with exact char offsets", () => {
    const buffer = createNarrationBuffer();
    buffer.push("Hello ");
    buffer.push("world");
    expect(buffer.take()).toEqual({ text: "Hello world", offset: 0 });
    expect(buffer.take()).toBeNull();
    buffer.push("!");
    expect(buffer.take()).toEqual({ text: "!", offset: 11 });
    expect(buffer.streamed()).toBe(12);
  });

  test("the total cap bounds what a chatty run can stream", () => {
    const buffer = createNarrationBuffer(10);
    buffer.push("0123456789ABCDEF");
    expect(buffer.take()).toEqual({ text: "0123456789", offset: 0 });
    buffer.push("more");
    expect(buffer.take()).toBeNull();
    expect(buffer.streamed()).toBe(10);
  });
});

describe("shimmer + surface helpers", () => {
  test("the working status derives from the step label", () => {
    expect(statusTextForStep("useAgent · computer_sequence")).toBe("is working: useAgent · computer_sequence");
  });

  test("DM channel ids are recognized by their D prefix", () => {
    expect(directMessageChannel("D0123")).toBe(true);
    expect(directMessageChannel("C0123")).toBe(false);
  });
});
