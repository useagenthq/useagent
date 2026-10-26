import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NativeFrame } from "./native-events";
import { SessionDetailsRail } from "./session-details-rail";
import type { ApiRun, ApiStep } from "./types";

function run(over: Partial<ApiRun> = {}): ApiRun {
  return {
    id: "run-1",
    org_id: null,
    user_id: null,
    prompt: "Add rate limiting",
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: null,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "run-1",
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [{ repo: "useagent/gateway", branch: "rl-staging" }],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-08-17T09:00:00Z",
    updated_at: "2026-08-17T09:01:00Z",
    steps: [],
    ...over,
  } as ApiRun;
}

const step = (id: string, code: Record<string, unknown>): ApiStep => ({
  id,
  run_id: "run-1",
  idx: 1,
  kind: "command",
  label: "Execute",
  chip: null,
  code_json: JSON.stringify(code),
  created_at: "2026-08-17T09:00:00Z",
});

type DetailsTurn = Parameters<typeof SessionDetailsRail>[0]["turns"][number];

function turn(over: Partial<DetailsTurn> = {}): DetailsTurn {
  return { run: run(), steps: [], status: "completed", ...over };
}

const usageFrame: NativeFrame = {
  schemaVersion: 1,
  eventId: "f1",
  seq: 1,
  provider: "opencode",
  eventType: "part.step-finish",
  native: {},
  payload: { tokens: { input: 12_000, output: 480, cache: { read: 400, write: 0 } } },
} as NativeFrame;

describe("SessionDetailsRail", () => {
  test("environment, the latest plan and usage read from the thread's own data", () => {
    const html = renderToStaticMarkup(
      <SessionDetailsRail
        root={run()}
        newest={run({ model: "claude-sonnet-5" })}
        turns={[
          turn({
            steps: [
              step("s1", { tool: "bash", input: { command: "bun test" }, output: "ok" }),
              step("s2", {
                tool: "todowrite",
                input: {
                  todos: [
                    { content: "Map the chain", status: "completed" },
                    { content: "Wire the limiter", status: "in_progress" },
                  ],
                },
              }),
            ],
            native: { nativeFrames: [usageFrame], childSessionIds: new Set<string>() },
          }),
        ]}
      />,
    );
    expect(html).toContain('data-testid="session-details"');
    expect(html).toContain(">Environment<");
    expect(html).toContain(">gateway<");
    expect(html).toContain(">rl-staging<");
    expect(html).toContain("OpenCode");
    expect(html).toContain(">Task plan<");
    expect(html).toContain('data-testid="details-plan"');
    expect(html).toContain("Wire the limiter");
    expect(html).toContain("1/2");
    // Usage tiles: 12,000 + 400 input, 480 output, one tool call (the plan is not a call).
    expect(html).toContain('data-testid="usage-input"');
    expect(html).toContain(">12.4k<");
    expect(html).toContain(">480<");
    expect(html).toContain('data-testid="usage-tool-calls"');
    expect(html).toContain(">1<");
    expect(html).not.toContain("not reported");
  });

  test("the runtime line presents the model as the one requested, not as the one that answered", () => {
    // runs.model is what the plane asked the runtime for; no runtime reports
    // the model that answered, so the rail must not read as a fact.
    const html = renderToStaticMarkup(
      <SessionDetailsRail root={run()} newest={run({ engine: "codex", model: "gpt-5.6-sol" })} turns={[turn()]} />,
    );
    expect(html).toContain("Codex");
    expect(html).toContain('data-testid="runtime-model-requested"');
    expect(html).toContain(">requested<");
    expect(html).toContain("not sent back");
  });

  test("a thread with unloaded outline turns says its plan and totals are partial", () => {
    const html = renderToStaticMarkup(
      <SessionDetailsRail
        root={run()}
        newest={run()}
        turns={[turn(), { ...turn(), pendingOutline: { stepCount: 4, hasSummary: true } }]}
      />,
    );
    expect(html).toContain('data-testid="details-partial"');
    expect(html).toContain("Older turns are still loading");
  });

  test("without a plan or reported tokens the rail says so instead of guessing", () => {
    const html = renderToStaticMarkup(
      <SessionDetailsRail
        root={run({ repo_specs: [], repos: [] })}
        newest={run({ repo_specs: [], repos: [] })}
        turns={[turn({ steps: [step("s1", { tool: "bash", input: { command: "ls" }, output: "" })] })]}
      />,
    );
    expect(html).toContain('data-testid="details-no-plan"');
    expect(html).toContain(">No plan yet<");
    expect(html).toContain(">No repository<");
    expect(html).toContain(">Default branch<");
    expect(html.match(/>not reported</g)).toHaveLength(2);
    expect(html).toContain(">1<");
  });
});
