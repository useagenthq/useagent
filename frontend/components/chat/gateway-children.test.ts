import { describe, expect, test } from "bun:test";
import { deriveThreadGatewayChildren, toGatewayChildSession } from "./gateway-children";
import type { EngineId, RunStatus } from "./types";

/** The minimal run/turn shape the derivation reads (Turn satisfies it too). */
const turn = (
  run: {
    id: string;
    prompt: string;
    engine?: EngineId;
    model?: string;
    parent_run_id?: string | null;
    child_session?: boolean;
  },
  status: RunStatus,
  summary: string | null = null,
) => ({
  run: { engine: "codex" as EngineId, model: "openai/gpt-5.6-sol", ...run },
  status,
  summary,
});

describe("deriveThreadGatewayChildren", () => {
  test("keeps only child_session runs that point at a parent, in spawn order", () => {
    const turns = [
      turn({ id: "parent" }, "running"),
      turn(
        { id: "c1", child_session: true, parent_run_id: "parent", prompt: "Get Google stock price" },
        "completed",
        "GOOGL $344",
      ),
      turn({ id: "reply", parent_run_id: "parent", prompt: "and now?" }, "queued"),
      turn(
        { id: "c2", child_session: true, parent_run_id: "parent", prompt: "Get NVIDIA stock price" },
        "queued",
      ),
      // A child mark with no parent is not a real gateway child; drop it.
      turn({ id: "orphan", child_session: true, parent_run_id: null, prompt: "stray" }, "running"),
    ];

    const children = deriveThreadGatewayChildren(turns);
    expect(children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(children[0]).toEqual({
      id: "c1",
      prompt: "Get Google stock price",
      engine: "codex",
      model: "openai/gpt-5.6-sol",
      status: "completed",
      summary: "GOOGL $344",
    });
  });
});

describe("toGatewayChildSession", () => {
  test("cleans the follow-up wrapper legacy runs stuffed into the prompt", () => {
    const child = toGatewayChildSession(
      turn(
        {
          id: "c1",
          child_session: true,
          parent_run_id: "parent",
          prompt: "Follow-up to a previous task. New request: Summarize the wiki",
        },
        "running",
      ),
    );
    expect(child.prompt).toBe("Summarize the wiki");
    expect(child.status).toBe("running");
  });
});
