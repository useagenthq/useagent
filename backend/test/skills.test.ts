import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { schedules } from "../src/db/schema";
import { createOrgSession, json, uid } from "./helpers";

describe("skills CRUD + run", () => {
  test("create → get in list → run increments usage → patch → delete → 404", async () => {
    const name = `Test Skill ${uid()}`;

    // Create.
    const created = await json<any>("/api/skills", {
      method: "POST",
      body: {
        name,
        description: "a test skill",
        tags: ["testing", "backend"],
        sections: {
          overview: ["do a thing"],
          procedure: ["step one", "step two"],
          verify: ["it worked"],
        },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(id).toBeTruthy();
    expect(created.body.usage_count).toBe(0);
    expect(created.body.last_run_at).toBeNull();
    expect(created.body.tags).toEqual(["testing", "backend"]);
    expect(created.body.sections.procedure).toEqual(["step one", "step two"]);
    expect(typeof created.body.created_at).toBe("string");

    // Appears in the list.
    const list = await json<{ skills: any[] }>("/api/skills");
    expect(list.body.skills.some((s) => s.id === id)).toBe(true);

    // Run: the endpoint now creates a REAL run through the command lane and
    // requires a prompt (no more misleading metric-only "run").
    const noPrompt = await json<any>(`/api/skills/${id}/run`, { method: "POST" });
    expect(noPrompt.status).toBe(400);

    // Two real runs → usage 0 → 2, last_run_at set.
    let ran = await json<any>(`/api/skills/${id}/run`, {
      method: "POST",
      body: { prompt: "exercise the skill", engine: "mock" },
    });
    expect(ran.status).toBe(201);
    expect(ran.body.id).toBeTruthy();
    ran = await json<any>(`/api/skills/${id}/run`, {
      method: "POST",
      body: { prompt: "again", engine: "mock" },
    });
    expect(ran.status).toBe(201);
    const afterRuns = await json<{ skills: any[] }>("/api/skills");
    const mine = afterRuns.body.skills.find((s) => s.id === id);
    expect(mine.usage_count).toBe(2);
    expect(mine.last_run_at).not.toBeNull();

    // Patch.
    const patched = await json<any>(`/api/skills/${id}`, {
      method: "PATCH",
      body: { description: "updated description", tags: ["only-one"] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.description).toBe("updated description");
    expect(patched.body.tags).toEqual(["only-one"]);
    expect(patched.body.usage_count).toBe(2); // unchanged by patch

    // Delete → then gone.
    const del = await json<any>(`/api/skills/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, id });

    const afterDelete = await json<any>(`/api/skills/${id}/run`, { method: "POST" });
    expect(afterDelete.status).toBe(404);
  });

  test("POST /api/skills requires a name", async () => {
    const { status, body } = await json("/api/skills", { method: "POST", body: {} });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  test("library view omits sections; GET /:id returns the full record", async () => {
    const created = await json<any>("/api/skills", {
      method: "POST",
      body: {
        name: `Library Skill ${uid()}`,
        description: "slim list, full detail",
        sections: { overview: ["a step"], procedure: [], verify: [] },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // The list carries import provenance (null for hand-authored skills).
    expect(created.body.source_repo).toBeNull();
    expect(created.body.source_path).toBeNull();

    const library = await json<{ skills: any[] }>("/api/skills?view=library");
    const slim = library.body.skills.find((s) => s.id === id);
    expect(slim).toBeTruthy();
    expect("sections" in slim).toBe(false);
    expect(slim.current_version).toBe(1);

    const full = await json<any>(`/api/skills/${id}`);
    expect(full.status).toBe(200);
    expect(full.body.sections.overview).toEqual(["a step"]);

    const missing = await json<any>(`/api/skills/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);

    expect((await json(`/api/skills/${id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("a keyed skill run replays after the selected skill is deleted", async () => {
    const created = await json<any>("/api/skills", {
      method: "POST",
      body: { name: `Replay Skill ${uid()}` },
    });
    const id = created.body.id as string;
    const key = uid("skill-replay");
    const first = await json<{ id: string }>(`/api/skills/${id}/run`, {
      method: "POST",
      body: { prompt: "run once", engine: "mock" },
      headers: { "Idempotency-Key": key },
    });
    expect(first.status).toBe(201);
    expect((await json(`/api/skills/${id}`, { method: "DELETE" })).status).toBe(200);

    const replay = await json<{ id: string }>(`/api/skills/${id}/run`, {
      method: "POST",
      body: { prompt: "run once", engine: "mock" },
      headers: { "Idempotency-Key": key },
    });
    expect(replay).toEqual({ status: 200, body: { id: first.body.id } });
  });

  test("PATCH/DELETE unknown id → 404", async () => {
    const missing = crypto.randomUUID();
    const patch = await json(`/api/skills/${missing}`, {
      method: "PATCH",
      body: { description: "x" },
    });
    expect(patch.status).toBe(404);
    const del = await json(`/api/skills/${missing}`, { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

describe("skill kind (skills vs playbooks over one substrate)", () => {
  test("picker view returns only composer fields", async () => {
    const name = `Picker ${uid()}`;
    const created = await json<any>("/api/skills", {
      method: "POST",
      body: {
        name,
        description: "large instructions are not needed by the composer",
        tags: ["picker"],
        sections: { overview: ["o"], procedure: ["p"], verify: ["v"] },
      },
    });
    expect(created.status).toBe(201);

    const list = await json<{ skills: any[] }>("/api/skills?view=picker&limit=2000");
    const picked = list.body.skills.find((skill) => skill.id === created.body.id);
    expect(picked).toEqual({
      id: created.body.id,
      name,
      kind: "skill",
      tags: ["picker"],
      current_version: 1,
    });

    const bounded = await json<{ skills: any[] }>("/api/skills?view=picker&limit=1");
    expect(bounded.body.skills).toHaveLength(1);
  });

  test("defaults to skill; kind:playbook persists; ?kind splits the list", async () => {
    const tag = `kind-${uid()}`;
    // A plain skill (no kind) defaults to "skill".
    const skill = await json<any>("/api/skills", {
      method: "POST",
      body: { name: `Skill ${uid()}`, description: "d", tags: [tag], sections: {} },
    });
    expect(skill.status).toBe(201);
    expect(skill.body.kind).toBe("skill");

    // A playbook is the same substrate with kind:"playbook".
    const playbook = await json<any>("/api/skills", {
      method: "POST",
      body: {
        name: `Playbook ${uid()}`,
        kind: "playbook",
        description: "d",
        tags: [tag],
        sections: { overview: ["o"], procedure: ["p"], verify: ["v"] },
      },
    });
    expect(playbook.status).toBe(201);
    expect(playbook.body.kind).toBe("playbook");

    // ?kind=playbook returns the playbook, not the skill (scoped to this run's tag).
    const onlyPlaybooks = await json<{ skills: any[] }>("/api/skills?kind=playbook");
    const pbIds = onlyPlaybooks.body.skills.filter((s) => s.tags.includes(tag)).map((s) => s.id);
    expect(pbIds).toContain(playbook.body.id);
    expect(pbIds).not.toContain(skill.body.id);

    // ?kind=skill is the mirror.
    const onlySkills = await json<{ skills: any[] }>("/api/skills?kind=skill");
    const skIds = onlySkills.body.skills.filter((s) => s.tags.includes(tag)).map((s) => s.id);
    expect(skIds).toContain(skill.body.id);
    expect(skIds).not.toContain(playbook.body.id);

    // No filter → both kinds present.
    const all = await json<{ skills: any[] }>("/api/skills");
    const allIds = all.body.skills.filter((s) => s.tags.includes(tag)).map((s) => s.id);
    expect(allIds).toContain(skill.body.id);
    expect(allIds).toContain(playbook.body.id);
  });

  test("an unknown kind is a 400 on create and matches nothing on list", async () => {
    const bad = await json<any>("/api/skills", {
      method: "POST",
      body: { name: `Bad ${uid()}`, kind: "workflow", description: "d", sections: {} },
    });
    expect(bad.status).toBe(400);

    const list = await json<{ skills: any[] }>("/api/skills?kind=workflow");
    expect(list.status).toBe(200);
    expect(list.body.skills).toEqual([]);
  });
});

describe("deleting a skill that automations still use", () => {
  async function createSkill(cookies: string, label: string): Promise<string> {
    const res = await json<{ id: string }>("/api/skills", {
      method: "POST",
      cookies,
      body: { name: `${label} ${uid()}`, description: "d", sections: { procedure: ["p"] } },
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  test("refuses while an enabled automation or bot routine in the org pins it, then allows", async () => {
    const org = await createOrgSession("skill-in-use");
    const other = await createOrgSession("skill-in-use-other");
    const { cookies } = org;
    const skillId = await createSkill(cookies, "Pinned");
    const otherSkillId = await createSkill(cookies, "Replacement");

    // An automation pinned to the skill, turned on (automations start paused).
    const automation = await json<{ id: string }>("/api/schedules", {
      method: "POST",
      cookies,
      body: { name: "Nightly digest", cron: "0 3 * * *", prompt: "digest", engine: "mock", skill: { id: skillId } },
    });
    expect(automation.status).toBe(201);
    // Paused, it does not hold the skill.
    const paused = await json<{ id: string }>("/api/schedules", {
      method: "POST",
      cookies,
      body: { name: "Paused digest", cron: "0 4 * * *", prompt: "digest", engine: "mock", skill: { id: skillId } },
    });
    expect(paused.status).toBe(201);
    expect(
      (await json(`/api/schedules/${automation.body.id}`, { method: "PATCH", cookies, body: { enabled: true } })).status,
    ).toBe(200);

    // A bot whose preset pins the skill; its routine carries that pin and is on.
    const bot = await json<{ bot: { id: string } }>("/api/bots", {
      method: "POST",
      cookies,
      body: { name: "Ledger", engine: "mock", skillIds: [skillId] },
    });
    expect(bot.status).toBe(201);
    const routine = await json<{ routine: { id: string; enabled: boolean } }>(`/api/bots/${bot.body.bot.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Weekly metrics", cron: "0 7 * * 1", prompt: "metrics" },
    });
    expect(routine.status).toBe(201);
    expect(routine.body.routine.enabled).toBe(true);

    // Another org's enabled automation naming the same skill id never counts.
    await db.insert(schedules).values({
      orgId: other.orgId,
      name: "Other org digest",
      cron: "0 5 * * *",
      timezone: "UTC",
      prompt: "digest",
      engine: "mock",
      skillId,
      enabled: true,
    });

    const refused = await json<any>(`/api/skills/${skillId}`, { method: "DELETE", cookies });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: "skill_in_use",
      used_by: [
        { name: "Nightly digest", bot: null },
        { name: "Weekly metrics", bot: "Ledger" },
      ],
      total: 2,
    });

    // Repoint the automation and pause the routine: only the routine is left,
    // then nothing in this org holds it.
    expect(
      (
        await json(`/api/schedules/${automation.body.id}`, {
          method: "PATCH",
          cookies,
          body: { skill: { id: otherSkillId } },
        })
      ).status,
    ).toBe(200);
    const stillRoutine = await json<any>(`/api/skills/${skillId}`, { method: "DELETE", cookies });
    expect(stillRoutine.status).toBe(409);
    expect(stillRoutine.body.used_by).toEqual([{ name: "Weekly metrics", bot: "Ledger" }]);

    expect(
      (
        await json(`/api/bots/${bot.body.bot.id}/routines/${routine.body.routine.id}`, {
          method: "PATCH",
          cookies,
          body: { enabled: false },
        })
      ).status,
    ).toBe(200);
    const deleted = await json<any>(`/api/skills/${skillId}`, { method: "DELETE", cookies });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, id: skillId });

    await db.delete(schedules).where(eq(schedules.orgId, other.orgId));
  });

  test("a refusal names a few holders and counts them all", async () => {
    const { cookies, orgId } = await createOrgSession("skill-in-use-many");
    const skillId = await createSkill(cookies, "Popular");
    await db.insert(schedules).values(
      Array.from({ length: 7 }, (_, n) => ({
        orgId,
        name: `Digest ${n}`,
        cron: "0 3 * * *",
        timezone: "UTC",
        prompt: "digest",
        engine: "mock" as const,
        skillId,
        enabled: true,
      })),
    );

    const refused = await json<any>(`/api/skills/${skillId}`, { method: "DELETE", cookies });
    expect(refused.status).toBe(409);
    expect(refused.body.total).toBe(7);
    expect(refused.body.used_by.map((holder: { name: string }) => holder.name)).toEqual([
      "Digest 0",
      "Digest 1",
      "Digest 2",
      "Digest 3",
      "Digest 4",
    ]);

    await db.delete(schedules).where(eq(schedules.orgId, orgId));
  });
});
