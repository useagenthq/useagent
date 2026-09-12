import { describe, expect, test } from "bun:test";
import {
  botWorkFailureCount,
  botWorkLabel,
  latestStepLabel,
  splitBotTurn,
} from "./bot-turn-model";
import type { TimelineNode } from "./timeline";
import type { ApiStep } from "./types";

function toolNode(id: string, code: Record<string, unknown>, createdAt = "2026-09-03T09:00:00Z"): TimelineNode {
  const step: ApiStep = {
    id,
    run_id: "run-1",
    idx: Number(id.slice(-1)),
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify(code),
    created_at: createdAt,
  };
  return { kind: "tool", key: id, step };
}

const RECALL: TimelineNode = {
  kind: "marker",
  key: "m1",
  marker: { kind: "context", source: "memory", itemCount: 4, query: null },
};
const THOUGHT: TimelineNode = { kind: "reasoning", key: "r1", text: "Check the log first." };
const NARRATION: TimelineNode = { kind: "text", key: "t1", text: "Looking at today's commits." };
const GIT_LOG = toolNode("s1", { tool: "execute", input: { command: "git log --since=yesterday" }, output: "b233c469 Merge" });
const TYPECHECK = toolNode(
  "s2",
  { tool: "execute", input: { command: "bun run typecheck" }, output: "", error: true },
  "2026-09-03T09:03:12Z",
);
const REPLY: TimelineNode = { kind: "text", key: "t2", text: "Here is today's digest." };
const ARTIFACT: TimelineNode = {
  kind: "artifact",
  key: "a1",
  artifact: { id: "a1", name: "digest.md", bytes: 10, sha256: "0".repeat(64), contentType: "text/markdown" },
};
const FOLLOWUPS: TimelineNode = { kind: "followups", key: "f1", suggestions: ["Post it to Slack"] };

const SETTLED = [RECALL, THOUGHT, NARRATION, GIT_LOG, TYPECHECK, REPLY, ARTIFACT, FOLLOWUPS];

describe("splitBotTurn", () => {
  test("a settled turn keeps the last burst as the reply and folds everything before it", () => {
    const { work, reply, tail } = splitBotTurn(SETTLED, false);
    expect(reply).toBe("Here is today's digest.");
    expect(work.map((n) => n.key)).toEqual(["m1", "r1", "t1", "s1", "s2"]);
    expect(tail.map((n) => n.key)).toEqual(["a1", "f1"]);
  });

  test("a multipart final reply keeps its complete contiguous text run visible", () => {
    const second = { kind: "text", key: "t3", text: "Second paragraph." } as const;
    const settled = splitBotTurn([GIT_LOG, REPLY, second, ARTIFACT], false);
    expect(settled.reply).toBe("Here is today's digest.\n\nSecond paragraph.");
    expect(settled.work.map((node) => node.key)).toEqual(["s1"]);

    const live = splitBotTurn([GIT_LOG, REPLY, second], true);
    expect(live.reply).toBe("Here is today's digest.\n\nSecond paragraph.");
  });

  test("settled work after the last burst still folds; the reply stays the last burst", () => {
    const { work, reply } = splitBotTurn([NARRATION, GIT_LOG, REPLY, TYPECHECK], false);
    expect(reply).toBe("Here is today's digest.");
    expect(work.map((n) => n.key)).toEqual(["t1", "s1", "s2"]);
  });

  test("while live, only a burst at the tail is the reply in progress", () => {
    const streaming = splitBotTurn([RECALL, GIT_LOG, REPLY], true);
    expect(streaming.reply).toBe("Here is today's digest.");
    expect(streaming.work.map((n) => n.key)).toEqual(["m1", "s1"]);

    const midWork = splitBotTurn([RECALL, NARRATION, GIT_LOG], true);
    expect(midWork.reply).toBeNull();
    expect(midWork.work.map((n) => n.key)).toEqual(["m1", "t1", "s1"]);
  });

  test("a tool-only turn has no reply", () => {
    expect(splitBotTurn([GIT_LOG, TYPECHECK], false).reply).toBeNull();
  });
});

describe("botWorkLabel", () => {
  test("settled: duration from the run plus the step count (prose is not a step)", () => {
    const { work } = splitBotTurn(SETTLED, false);
    expect(botWorkLabel({ live: false, work, durationMs: 192_000 })).toBe(
      "Worked for 3m 12s, 4 steps, 1 failed",
    );
    expect(botWorkFailureCount(work)).toBe(1);
  });

  test("settled without a run duration falls back to the steps' own timestamps", () => {
    const { work } = splitBotTurn(SETTLED, false);
    expect(botWorkLabel({ live: false, work, durationMs: null })).toBe(
      "Worked for 3m 12s, 4 steps, 1 failed",
    );
    expect(botWorkLabel({ live: false, work: [RECALL], durationMs: null })).toBe("Worked, 1 step");
  });

  test("live: the latest step's human label, never its raw payload", () => {
    expect(botWorkLabel({ live: true, work: [RECALL, GIT_LOG, TYPECHECK], durationMs: null })).toBe(
      "Working, bun run typecheck (failed)",
    );
    expect(botWorkLabel({ live: true, work: [GIT_LOG, THOUGHT], durationMs: null })).toBe(
      "Working, Thinking",
    );
    expect(botWorkLabel({ live: true, work: [RECALL], durationMs: null })).toBe("Working");
    expect(latestStepLabel([])).toBeNull();
  });
});
