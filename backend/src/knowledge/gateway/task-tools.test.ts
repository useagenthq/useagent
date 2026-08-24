import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../../index"; // run committed migrations before DB-backed gateway assertions
import { db } from "../../db/client";
import { providerEvents, runs, tasks } from "../../db/schema";
import { createRun, setRunStatus } from "../../runs/repo";
import { createTask, listTasksForOrg } from "../../tasks/repo";
import { executeTaskTool, TASK_TOOLS } from "./task-tools";
import type { ToolTokenClaims } from "./token";

const createdRuns = new Set<string>();
const createdOrgs = new Set<string>();

afterEach(async () => {
  for (const orgId of createdOrgs) await db.delete(tasks).where(eq(tasks.orgId, orgId));
  for (const runId of Array.from(createdRuns).reverse()) {
    await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
  createdRuns.clear();
  createdOrgs.clear();
});

async function fixture(): Promise<{ claims: ToolTokenClaims; repo: string; otherOrgId: string }> {
  const orgId = `org-task-tools-${crypto.randomUUID()}`;
  const otherOrgId = `org-task-tools-other-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const repo = `acme/web-${crypto.randomUUID().slice(0, 8)}`;
  createdOrgs.add(orgId);
  createdOrgs.add(otherOrgId);
  createdRuns.add(runId);

  await createRun({
    id: runId,
    prompt: "do work",
    model: "mock-model",
    engine: "mock",
    orgId,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: [repo],
    memoryScope: "org",
  });
  await setRunStatus(runId, "running");

  return {
    claims: {
      orgId,
      userId: "user-1",
      threadId: runId,
      runId,
      scope: "run",
      exp: Date.now() + 60_000,
    },
    repo,
    otherOrgId,
  };
}

describe("durable task gateway", () => {
  test("exposes create, list, and update tools", () => {
    expect(TASK_TOOLS.map((tool) => tool.name)).toEqual([
      "task_create",
      "task_list",
      "task_update",
    ]);
  });

  test("task_create persists org-scoped and defaults the project to the run's repo", async () => {
    const { claims, repo, otherOrgId } = await fixture();
    const result = await executeTaskTool(claims, "task_create", { title: "Follow up on flake" });
    expect(result.isError).toBeUndefined();
    const task = result.structuredContent?.task as {
      id: string;
      project: string | null;
      status: string;
    };
    expect(task.project).toBe(repo);
    expect(task.status).toBe("todo");

    // Persisted under this org, not visible to another org.
    const mine = await listTasksForOrg(claims.orgId);
    expect(mine.map((t) => t.id)).toContain(task.id);
    expect(mine[0]?.sourceRunId).toBe(claims.runId);
    const others = await listTasksForOrg(otherOrgId);
    expect(others).toHaveLength(0);
  });

  test("task_list returns only this org's tasks", async () => {
    const { claims, repo, otherOrgId } = await fixture();
    await executeTaskTool(claims, "task_create", { title: "Mine" });
    // A same-project task in a DIFFERENT org must never leak in.
    await createTask({ orgId: otherOrgId, projectKey: repo, title: "Theirs" });

    const listed = await executeTaskTool(claims, "task_list", {});
    const rows = (listed.structuredContent?.tasks ?? []) as Array<{ title: string }>;
    const titles = rows.map((t) => t.title);
    expect(titles).toContain("Mine");
    expect(titles).not.toContain("Theirs");
  });

  test("task_update transitions status and fails closed cross-org", async () => {
    const { claims, otherOrgId } = await fixture();
    const created = await executeTaskTool(claims, "task_create", { title: "Move me" });
    const taskId = (created.structuredContent?.task as { id: string }).id;

    const updated = await executeTaskTool(claims, "task_update", {
      taskId,
      status: "in_progress",
    });
    expect(updated.isError).toBeUndefined();
    expect((updated.structuredContent?.task as { status: string }).status).toBe("in_progress");

    // A task owned by another org is not found for this run's token.
    const theirs = await createTask({ orgId: otherOrgId, title: "Not yours" });
    const crossOrg = await executeTaskTool(claims, "task_update", {
      taskId: theirs.id,
      status: "done",
    });
    expect(crossOrg.isError).toBe(true);
  });

  test("an explicit project files the task outside the run's repo", async () => {
    const { claims } = await fixture();
    const result = await executeTaskTool(claims, "task_create", {
      title: "Cross-project",
      project: "other/repo",
    });
    expect((result.structuredContent?.task as { project: string }).project).toBe("other/repo");
  });
});
