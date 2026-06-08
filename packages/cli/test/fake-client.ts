// Test doubles: a fully-stubbed FleetClient (override any method per test) plus small
// builders for the ApiRun / ApiRunSummary rows the real client would return.

import type { FleetClient } from "@useagent/agent-client/fleet";
import type { ApiRun, ApiRunSummary } from "@useagent/agent-client/wire";

export function makeApiRun(overrides: Partial<ApiRun> = {}): ApiRun {
  return {
    id: "run_x",
    org_id: "org-1",
    user_id: "user-1",
    prompt: "hello",
    model: "anthropic/claude-sonnet-5",
    engine: "opencode",
    status: "running",
    summary: null,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "run_x",
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
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    steps: [],
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<ApiRunSummary> = {}): ApiRunSummary {
  return {
    id: "run_x",
    prompt: "hello",
    model: "anthropic/claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: "done",
    duration_ms: 10,
    repo: null,
    repos: [],
    repo_specs: [],
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function fakeClient(overrides: Partial<FleetClient> = {}): FleetClient {
  const urlFor = (id: string): string => `https://fleet.test/session/${id}`;
  const base: FleetClient = {
    baseUrl: "https://fleet.test",
    urlFor,
    dispatch: async () => ({ runId: "run_x", status: "queued", url: urlFor("run_x") }),
    dispatchMany: async (tasks) =>
      tasks.map((task, i) => ({
        ok: true as const,
        task,
        run: { runId: `run_${i}`, status: "queued", url: urlFor(`run_${i}`) },
      })),
    dispatchBatch: async (tasks) => ({
      batchId: "batch_x",
      status: "queued",
      createdAt: "2026-08-28T00:00:00.000Z",
      replayed: false,
      runs: tasks.map((_task, ordinal) => ({
        ordinal,
        runId: `run_${ordinal}`,
        status: "queued",
        queue: { state: "queued", reason: "global_limit" },
        url: urlFor(`run_${ordinal}`),
      })),
    }),
    getBatch: async () => ({
      batchId: "batch_x",
      status: "completed",
      createdAt: "2026-08-28T00:00:00.000Z",
      replayed: false,
      runs: [],
    }),
    getRun: async (runId) => ({ runId, status: "completed", run: null, answer: "done", url: urlFor(runId) }),
    awaitSettled: async (runId) => ({ runId, status: "completed", run: null, answer: "done", url: urlFor(runId) }),
    verify: async (runId) => ({ verdict: "pass", evidence: "VERDICT: PASS", runId: `${runId}:qc`, status: "completed", url: urlFor(`${runId}:qc`) }),
    listRecent: async () => [],
  };
  return { ...base, ...overrides };
}
