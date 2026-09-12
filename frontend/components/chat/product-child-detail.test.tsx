import { expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiRun } from "@/components/chat/types";
import { ProductChildDetailBody } from "@/components/chat/product-child-detail";

const relationship: ThreadRelationship = {
  threadId: "child-1",
  parentThreadId: "root",
  familyThreadId: "root",
  kind: "delegated",
  title: "Research NVIDIA and Google",
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  status: "completed",
  engine: "codex",
  model: "gpt-5.6-luna",
  latestRunId: "child-1",
  latestSummary: "NVDA and GOOGL prices are ready.",
  latestDurationMs: 1_500,
  latestActivityAt: "2026-09-01T00:01:00.000Z",
};

const run: ApiRun = {
  id: "child-1",
  org_id: "org-1",
  user_id: "user-1",
  project_id: null,
  prompt: "Find NVIDIA and Google prices",
  model: "gpt-5.6-luna",
  engine: "codex",
  status: "completed",
  summary: "NVDA and GOOGL prices are ready.",
  duration_ms: 1_500,
  parent_run_id: null,
  child_session: false,
  thread_id: "child-1",
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
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:01:00.000Z",
  steps: [],
};

test("renders a completed child answer and an in-place message composer", () => {
  const html = renderToStaticMarkup(
    <ProductChildDetailBody
      initialRun={run}
      relationship={relationship}
      onBack={() => {}}
      onRunAccepted={() => {}}
    />,
  );
  expect(html).toContain("NVDA and GOOGL prices are ready.");
  expect(html).toContain("Message this child…");
  expect(html).not.toContain('href="/session/child-1"');
});
