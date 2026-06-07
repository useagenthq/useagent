// SubagentChips derives from the thread runs already held by SessionView. It
// must never fetch or promote ordinary replies into the gateway-child surface.
// Run: `bun test components/chat/subagent-pane.test.tsx` (from frontend/).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentChips } from "./subagent-pane";
import type { ApiRun } from "./types";

function makeRun(
  id: string,
  prompt: string,
  options: { parentRunId?: string | null; childSession?: boolean } = {},
): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    project_id: null,
    prompt,
    model: "claude-opus-5",
    engine: "opencode",
    status: "running",
    summary: null,
    duration_ms: null,
    parent_run_id: options.parentRunId ?? null,
    child_session: options.childSession ?? false,
    thread_id: "root",
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    steps: [],
  };
}

describe("SubagentChips", () => {
  test("shows only genuine durable gateway children across multiple parent turns", () => {
    const root = makeRun("root", "Root turn");
    const replyOne = makeRun("reply-1", "Normal reply one", { parentRunId: "root" });
    const child = makeRun("child-1", "Research in parallel", {
      parentRunId: "reply-1",
      childSession: true,
    });
    const replyTwo = makeRun("reply-2", "Normal reply two", { parentRunId: "child-1" });

    const html = renderToStaticMarkup(
      <SubagentChips
        rootId="root"
        thread={[root, replyOne, child, replyTwo]}
        excludeIds={["root", "reply-1", "reply-2"]}
      />,
    );

    expect(html).toContain("Subagents");
    expect(html).toContain("Research in parallel");
    expect(html).toContain('title="Research in parallel"');
    expect(html).not.toContain("Normal reply one");
    expect(html).not.toContain("Normal reply two");
  });

  test("does not promote a parented ordinary reply or an unstamped pseudo-child", () => {
    const html = renderToStaticMarkup(
      <SubagentChips
        rootId="root"
        thread={[
          makeRun("root", "Root turn"),
          makeRun("reply", "Ordinary reply", { parentRunId: "root" }),
          makeRun("pseudo", "Not a durable child", { childSession: true }),
        ]}
      />,
    );

    expect(html).toBe("");
  });
});
