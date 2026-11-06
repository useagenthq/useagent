import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiRun } from "./types";
import { LoadedPane } from "./subagent-pane-body";
import { PaneStub } from "./subagent-pane";

function run(
  id: string,
  options: { parentRunId?: string | null; childSession?: boolean } = {},
): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    project_id: null,
    prompt: `Prompt for ${id}`,
    model: "gpt-5.6-sol",
    engine: "codex",
    status: "completed",
    summary: null,
    duration_ms: null,
    parent_run_id: options.parentRunId ?? null,
    child_session: options.childSession ?? false,
    thread_id: "root",
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    steps: [],
  };
}

describe("run peek body", () => {
  test.each([
    ["root run", run("root")],
    ["ordinary parented reply", run("reply", { parentRunId: "root" })],
  ])("renders a %s as a session without child controls", (_name, initialRun) => {
    const html = renderToStaticMarkup(<LoadedPane initialRun={initialRun} />);

    expect(html).toContain(">Thread<");
    expect(html).toContain('href="/session/root"');
    expect(html).toContain("Open thread");
    expect(html).not.toContain(">Subagent<");
    expect(html).not.toContain("Pass instructions down");
  });

  test("renders an actual gateway child with subagent controls", () => {
    const html = renderToStaticMarkup(
      <LoadedPane initialRun={run("child", { parentRunId: "root", childSession: true })} />,
    );

    expect(html).toContain(">Subagent<");
    expect(html).toContain("Pass instructions down");
    expect(html).not.toContain("Open thread");
  });

  test("loading and error shells are neutral unless the caller knows it is a child", () => {
    expect(renderToStaticMarkup(<PaneStub>Loading</PaneStub>)).toContain(">Thread<");
    expect(renderToStaticMarkup(<PaneStub label="Run">Loading</PaneStub>)).toContain(">Run<");
    expect(renderToStaticMarkup(<PaneStub childSession>Loading</PaneStub>)).toContain(
      ">Subagent<",
    );
  });
});
