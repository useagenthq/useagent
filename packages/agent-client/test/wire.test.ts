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
  project_id: null,
  repo: null,
  repos: [],
  repo_specs: [],
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
  latest_run_id: "run-2",
  latest_status: "running",
  latest_created_at: "2026-08-24T00:01:00.000Z",
  latest_updated_at: "2026-08-24T00:02:00.000Z",
} satisfies ApiRunSummary;

const run = {
  id: summary.id,
  prompt: summary.prompt,
  model: summary.model,
  engine: summary.engine,
  status: summary.status,
  summary: summary.summary,
  duration_ms: summary.duration_ms,
  project_id: summary.project_id,
  repo: summary.repo,
  repos: summary.repos,
  repo_specs: summary.repo_specs,
  created_at: summary.created_at,
  updated_at: summary.updated_at,
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

  test("synthesizes latest projection fields for legacy compact run rows", () => {
    const {
      latest_run_id: _latestRunId,
      latest_status: _latestStatus,
      latest_created_at: _latestCreatedAt,
      latest_updated_at: _latestUpdatedAt,
      ...legacySummary
    } = summary;

    expect(decodeApiRunSummary(legacySummary)).toEqual({
      ...legacySummary,
      latest_run_id: legacySummary.id,
      latest_status: legacySummary.status,
      latest_created_at: legacySummary.created_at,
      latest_updated_at: legacySummary.updated_at,
    });
  });

  test("rejects partial latest projection fields", () => {
    expect(decodeApiRunSummary({ ...summary, latest_updated_at: undefined })).toBeNull();
  });

  test("rejects unknown statuses and step kinds instead of typing them", () => {
    expect(decodeApiRun({ ...run, status: "done" })).toBeNull();
    expect(decodeApiRunSummary({ ...summary, status: "done" })).toBeNull();
    expect(decodeApiRunSummary({ ...summary, latest_status: "done" })).toBeNull();
    expect(decodeApiStep({ ...step, kind: "shell" })).toBeNull();
  });
});
