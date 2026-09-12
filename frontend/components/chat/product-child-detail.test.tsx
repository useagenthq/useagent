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
  bot: null,
  followUpRunIds: [],
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
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:01:00.000Z",
  steps: [],
};

test("renders a completed child answer with a one-line status and links to the thread", () => {
  const html = renderToStaticMarkup(
    <ProductChildDetailBody initialRun={run} relationship={relationship} onBack={() => {}} />,
  );
  expect(html).toContain("NVDA and GOOGL prices are ready.");
  expect(html).toContain("Completed · child thread · Codex · gpt-5.6-luna");
  expect(html).toContain("Open thread to reply");
  expect(html.match(/href="\/session\/child-1"/g)).toHaveLength(2);
  expect(html).not.toContain("Message this child");
  expect(html).not.toContain("Product child");
});

test("a bot thread is named after its bot", () => {
  const html = renderToStaticMarkup(
    <ProductChildDetailBody
      initialRun={run}
      relationship={{ ...relationship, bot: { id: "bot-1", name: "Nova" } }}
      onBack={() => {}}
    />,
  );
  expect(html).toContain("Completed · Nova · bot thread · Codex · gpt-5.6-luna");
  expect(html).toContain('aria-label="Open bot thread: Research NVIDIA and Google"');
});

test("renders child answer markdown without enabling unsafe URLs or raw HTML", () => {
  const markdown = [
    "**Prices ready**",
    "",
    "| Symbol | Price |",
    "| --- | --- |",
    "| NVDA | $100 |",
    "",
    "[Source](https://example.com/prices)",
    "[Unsafe](javascript:alert(1))",
    "",
    "<script>alert('raw html')</script>",
  ].join("\n");
  const html = renderToStaticMarkup(
    <ProductChildDetailBody
      initialRun={{ ...run, summary: markdown }}
      relationship={{ ...relationship, latestSummary: markdown }}
      onBack={() => {}}
    />,
  );

  expect(html).toContain("<strong>Prices ready</strong>");
  expect(html).toContain("<table");
  expect(html).toContain('<a href="https://example.com/prices" target="_blank" rel="noreferrer">Source</a>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<script>");
});
