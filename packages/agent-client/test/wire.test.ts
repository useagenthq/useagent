import { describe, expect, test } from "bun:test";

import {
  decodeApiRun,
  decodeApiRunSummary,
  decodeApiStep,
  type ApiRun,
  type ApiRunSummary,
  type ApiStep,
  RUN_STATUSES,
  STEP_KINDS,
} from "../src/wire";

const step = {
  id: "step-1",
  run_id: "run-1",
  idx: 0,
  kind: "command",
  label: "Run",
  chip: null,
  code_json: null,
  created_at: "2026-08-24T00:00:00.000Z",
} satisfies ApiStep;

const summary = {
  id: "run-1",
  prompt: "hello",
  model: "openai/gpt-5.6-luna",
  engine: "opencode",
  status: "running",
  summary: null,
  duration_ms: null,
  repo: null,
  repos: [],
  repo_specs: [],
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
} satisfies ApiRunSummary;

const run = {
  ...summary,
  org_id: "org-1",
  user_id: "user-1",
  parent_run_id: null,
  child_session: false,
  thread_id: "run-1",
  engine_session_id: null,
  resolved_resources: [],
  memory_scope: "org",
  skill_id: null,
  skill_version: null,
  skill_content_hash: null,
  uploads: [],
  steps: [step],
} satisfies ApiRun;

describe("run/step wire boundary decoders", () => {
  test("exports the accepted enum values that derive the shared types", () => {
    expect(RUN_STATUSES).toEqual(["queued", "running", "completed", "failed"]);
    expect(STEP_KINDS).toEqual(["command", "file", "task", "done"]);
  });

  test("decodes valid full and compact run rows", () => {
    expect(decodeApiRun(run)).toEqual(run);
    expect(decodeApiRunSummary(summary)).toEqual(summary);
    expect(decodeApiStep(step)).toEqual(step);
  });

  test("rejects unknown statuses and step kinds instead of typing them", () => {
    expect(decodeApiRun({ ...run, status: "done" })).toBeNull();
    expect(decodeApiRunSummary({ ...summary, status: "done" })).toBeNull();
    expect(decodeApiStep({ ...step, kind: "shell" })).toBeNull();
  });
});
