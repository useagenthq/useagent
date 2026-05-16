import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { providerEvents, runs, skills } from "../../db/schema";
import { createRun, getRunForOrg, setRunStatus } from "../../runs/repo";
import { createSkillWithRevision } from "../../skills/repo";
import { executeSkillTool, SKILL_TOOLS } from "./skill-tools";
import { resolveToolRunIdentity } from "./run-authorization";
import type { ToolTokenClaims } from "./token";

const createdRuns = new Set<string>();
const createdOrgs = new Set<string>();

afterEach(async () => {
  for (const runId of Array.from(createdRuns).reverse()) {
    await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
  for (const orgId of createdOrgs) await db.delete(skills).where(eq(skills.orgId, orgId));
  createdRuns.clear();
  createdOrgs.clear();
});

async function fixture(): Promise<{
  claims: ToolTokenClaims;
  skillId: string;
  otherSkillId: string;
}> {
  const orgId = `org-skill-tools-${crypto.randomUUID()}`;
  const otherOrgId = `org-skill-tools-other-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  createdOrgs.add(orgId);
  createdOrgs.add(otherOrgId);
  createdRuns.add(runId);

  const skill = await createSkillWithRevision({
    orgId,
    name: "inspect-production-dashboard",
    description: "Inspect a production dashboard using the authenticated workspace tools.",
    tags: ["dashboard", "inspection"],
    sections: {
      overview: ["Use the trusted workspace context."],
      procedure: ["Open the dashboard.", "Verify the result."],
      verify: ["Report the visible state."],
    },
  });
  const other = await createSkillWithRevision({
    orgId: otherOrgId,
    name: "cross-tenant-secret",
    description: "Must never be listed or activated across organizations.",
    tags: ["private"],
    sections: { overview: ["Private."], procedure: ["No."], verify: ["No."] },
  });
  if (!skill || !other) throw new Error("skill fixture creation failed");

  await createRun({
    id: runId,
    prompt: "inspect the dashboard",
    model: "mock-model",
    engine: "mock",
    orgId,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: [],
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
    skillId: skill.id,
    otherSkillId: other.id,
  };
}

describe("agent-selected skill gateway", () => {
  test("exposes catalog and activation tools without a prompt or query argument", () => {
    expect(SKILL_TOOLS.map((tool) => tool.name)).toEqual(["skills_list", "skill_activate"]);
    expect(JSON.stringify(SKILL_TOOLS[0]?.inputSchema)).not.toContain("query");
    expect(JSON.stringify(SKILL_TOOLS)).not.toContain("organization slug");
  });

  test("paginates the complete catalog without filtering by prompt text", async () => {
    const { claims } = await fixture();
    const second = await createSkillWithRevision({
      orgId: claims.orgId,
      name: "second-workflow",
      description: "A distinct workflow that must remain discoverable on later pages.",
      tags: [],
      sections: { overview: ["Second."], procedure: ["Continue."], verify: ["Done."] },
    });
    if (!second) throw new Error("second skill fixture creation failed");

    const firstPage = await executeSkillTool(claims, "skills_list", { limit: 1 });
    const cursor = firstPage.structuredContent?.nextCursor;
    expect(cursor).toBe(1);

    const secondPage = await executeSkillTool(claims, "skills_list", { cursor, limit: 1 });
    const ids = (secondPage.structuredContent?.skills ?? []) as Array<{ id: string }>;
    expect(ids).toHaveLength(1);
    expect(secondPage.structuredContent).toHaveProperty("nextCursor", null);
  });

  test("lists only the authenticated organization's catalog", async () => {
    const { claims, skillId, otherSkillId } = await fixture();
    const result = await executeSkillTool(claims, "skills_list", {});
    const ids = ((result.structuredContent?.skills ?? []) as Array<{ id: string }>).map(({ id }) => id);
    expect(ids).toContain(skillId);
    expect(ids).not.toContain(otherSkillId);
    expect(result.content[0]?.text).toContain("inspect-production-dashboard");
    expect(result.content[0]?.text).not.toContain("cross-tenant-secret");
  });

  test("activates the current immutable revision and returns its full procedure", async () => {
    const { claims, skillId } = await fixture();
    const result = await executeSkillTool(claims, "skill_activate", { skillId });
    const run = await getRunForOrg(claims.orgId, claims.runId);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Open the dashboard.");
    expect(run?.skillId).toBe(skillId);
    expect(run?.skillVersion).toBe(1);
    expect(run?.skillContentHash).toBeString();
  });

  test("fails closed for cross-org skills and settled runs", async () => {
    const { claims, skillId, otherSkillId } = await fixture();
    const crossOrg = await executeSkillTool(claims, "skill_activate", { skillId: otherSkillId });
    expect(crossOrg.isError).toBe(true);

    await setRunStatus(claims.runId, "completed");
    const settled = await executeSkillTool(claims, "skill_activate", { skillId });
    expect(settled.isError).toBe(true);
    expect(settled.content[0]?.text).toContain("current running turn");
  });

  test("a resident thread capability cannot cross users and a refreshed one activates only the live turn", async () => {
    const { claims, skillId } = await fixture();
    await setRunStatus(claims.runId, "completed");

    const nextRunId = crypto.randomUUID();
    createdRuns.add(nextRunId);
    await createRun({
      id: nextRunId,
      prompt: "continue with a different user",
      model: "mock-model",
      engine: "mock",
      orgId: claims.orgId,
      userId: "user-2",
      parentRunId: claims.runId,
      threadId: claims.threadId,
      repos: [],
      memoryScope: "org",
    });
    await setRunStatus(nextRunId, "running");

    const stale = await resolveToolRunIdentity({ ...claims, scope: "thread" });
    expect(stale).toBeNull();

    const refreshed = await resolveToolRunIdentity({
      ...claims,
      runId: nextRunId,
      userId: "user-2",
      scope: "thread",
    });
    expect(refreshed?.runId).toBe(nextRunId);
    const result = await executeSkillTool(refreshed!, "skill_activate", { skillId });
    expect(result.isError).toBeUndefined();
    expect((await getRunForOrg(claims.orgId, claims.runId))?.skillId).toBeNull();
    expect((await getRunForOrg(claims.orgId, nextRunId))?.skillId).toBe(skillId);
  });
});
