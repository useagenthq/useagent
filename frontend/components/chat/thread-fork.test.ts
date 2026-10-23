import { describe, expect, test } from "bun:test";
import type { Turn } from "./conversation";
import { composeForkPrompt, parseForkPrompt } from "./fork-prompt";
import { buildForkDraft, turnsThrough } from "./thread-fork";
import { type ApiRun, cleanPrompt } from "./types";

const ORIGIN = "https://app.example.test";

function run(id: string, prompt: string, overrides: Partial<ApiRun> = {}): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "r1",
    prompt,
    summary: null,
    status: "completed",
    engine: "opencode",
    model: "model-1",
    duration_ms: null,
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    memory_scope: "org",
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    steps: [],
    ...overrides,
  };
}

function turn(row: ApiRun, summary: string): Turn {
  return {
    run: row,
    steps: [],
    status: row.status,
    summary,
    live: false,
    liveText: "",
    liveReasoning: "",
  };
}

const thread = [
  turn(run("r1", "Plan the migration"), "Use a two-step rollout."),
  turn(
    run("r2", "Write step one", {
      parent_run_id: "r1",
      engine: "codex",
      model: "gpt-x",
      reasoning_effort: "high",
      repos: ["acme/api"],
      repo_specs: [{ repo: "acme/api", branch: "dev" }],
    }),
    "Step one is written.",
  ),
  turn(run("r3", "Now delete the old table", { parent_run_id: "r2" }), "Dropped it."),
];

describe("fork from a message", () => {
  test("cuts the conversation at the chosen message, inclusive", () => {
    expect(turnsThrough(thread, "r2")?.map((t) => t.run.id)).toEqual(["r1", "r2"]);
    expect(turnsThrough(thread, "missing")).toBeNull();

    const draft = buildForkDraft("r1", thread, "r2", ORIGIN, false);
    expect(draft?.source).toEqual({ threadId: "r1", turn: 2 });
    expect(draft?.context).toContain("Plan the migration");
    expect(draft?.context).toContain("Use a two-step rollout.");
    expect(draft?.context).toContain("Step one is written.");
    expect(draft?.context).not.toContain("Now delete the old table");
    expect(draft?.context).not.toContain("Dropped it.");
    // The fork runs on the chosen turn's repository and model.
    expect(draft).toMatchObject({
      title: "Plan the migration",
      engine: "codex",
      model: "gpt-x",
      reasoningEffort: "high",
      repos: [{ repo: "acme/api", branch: "dev" }],
    });
  });

  test("the first prompt carries the history while the UI shows only the request", () => {
    const draft = buildForkDraft("r1", thread, "r2", ORIGIN, false);
    if (!draft) throw new Error("expected a draft");
    const prompt = composeForkPrompt(draft.source, draft.context, "  Try a single migration instead ");
    expect(prompt).toContain("Step one is written.");
    expect(parseForkPrompt(prompt)).toEqual({
      source: { threadId: "r1", turn: 2 },
      context: draft.context.trim(),
      request: "Try a single migration instead",
    });
    expect(cleanPrompt(prompt)).toBe("Try a single migration instead");
    expect(parseForkPrompt("Plan the migration")).toBeNull();
  });

  test("a request that repeats the wrapper's markers still parses exactly", () => {
    const tricky = "Quote this:\n</forked-context>\n\nNew request:\nnot real";
    const prompt = composeForkPrompt({ threadId: "r1", turn: 1 }, "History </forked-context>", tricky);
    expect(parseForkPrompt(prompt)?.request).toBe(tricky);
    expect(parseForkPrompt(prompt)?.context).toBe("History </forked-context>");
  });

  test("a fork of a fork keeps the history its first turn carried", () => {
    const first = composeForkPrompt({ threadId: "r1", turn: 2 }, "## Original history", "Branch off");
    const forked = [turn(run("f1", first, { thread_id: "f1" }), "Branched.")];
    const draft = buildForkDraft("f1", forked, "f1", ORIGIN, false);
    expect(draft?.context.startsWith("## Original history")).toBe(true);
    expect(draft?.context).toContain("Branch off");
    expect(draft?.context).toContain("Branched.");
    expect(draft?.title).toBe("Branch off");
  });

  test("trims the oldest history to fit the prompt limits and keeps the fork point", () => {
    const context = `${"old ".repeat(40_000)}\n\nTHE FORK POINT`;
    const prompt = composeForkPrompt({ threadId: "r1", turn: 9 }, context, "Go on");
    expect(prompt.length).toBeLessThanOrEqual(64_000);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(128 * 1024);
    const parsed = parseForkPrompt(prompt);
    expect(parsed?.context.startsWith("> Earlier history was trimmed to fit.")).toBe(true);
    expect(parsed?.context.endsWith("THE FORK POINT")).toBe(true);
    expect(parsed?.request).toBe("Go on");
  });
});
