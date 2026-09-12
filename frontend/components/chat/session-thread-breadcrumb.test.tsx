import { expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionThreadBreadcrumb } from "./session-thread-breadcrumb";

const relationship = (threadId: string, parentThreadId: string | null, title: string): ThreadRelationship => ({
  threadId,
  parentThreadId,
  familyThreadId: "root",
  kind: parentThreadId ? "delegated" : "root",
  title,
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  status: "completed",
  engine: "codex",
  model: "gpt-5.6-sol",
  latestRunId: threadId,
  latestActivityAt: "2026-09-01T00:00:00.000Z",
});

test("a product child keeps its parent and own title visible", () => {
  const html = renderToStaticMarkup(
    <SessionThreadBreadcrumb
      relationship={relationship("child", "root", "Build calendar grid")}
      parent={relationship("root", null, "Calendar app")}
    />,
  );
  expect(html).toContain('href="/session/root"');
  expect(html).toContain("Calendar app");
  expect(html).toContain("Build calendar grid");
  expect(html).toContain('aria-label="Back to Calendar app"');
});

test("an ordinary root keeps the compact session label", () => {
  expect(renderToStaticMarkup(
    <SessionThreadBreadcrumb relationship={relationship("root", null, "Calendar app")} parent={null} />,
  )).toContain("Session");
});
