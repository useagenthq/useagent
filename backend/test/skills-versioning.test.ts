import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents, skillRevisions } from "../src/db/schema";
import { formatSkillMarkdown, hashSkillContent } from "../src/skills/format";
import { createOrgSession, fetchApi, json, readSse, uid, waitFor } from "./helpers";

const sections = (overview: string[], procedure: string[], verify: string[]) => ({
  overview,
  procedure,
  verify,
});

async function createSkill(cookies: string, body: Record<string, unknown>): Promise<any> {
  const res = await json<any>("/api/skills", { method: "POST", cookies, body });
  expect(res.status).toBe(201);
  return res.body;
}

/** The content hash the backend pins for a skill's current content. */
function hashOf(skill: { name: string; description: string; sections: any }): string {
  return hashSkillContent(
    formatSkillMarkdown({
      name: skill.name,
      description: skill.description,
      sections: skill.sections,
    }),
  );
}

describe("skill revisions + versioning", () => {
  test("create pins v1; a content edit mints v2 while v1 stays immutable", async () => {
    const s = await createOrgSession("skill-ver");
    const created = await createSkill(s.cookies, {
      name: `Haiku ${uid()}`,
      description: "Always answer as a haiku.",
      tags: ["style"],
      sections: sections(["Answer in haiku."], ["Compose 5-7-5."], ["Three lines."]),
    });
    expect(created.current_version).toBe(1);

    const [v1] = await db
      .select()
      .from(skillRevisions)
      .where(and(eq(skillRevisions.skillId, created.id), eq(skillRevisions.version, 1)));
    expect(v1).toBeTruthy();
    expect(v1!.contentHash).toBe(hashOf(created));

    // A content edit → v2, v1 untouched.
    const edited = await json<any>(`/api/skills/${created.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { description: "Answer as a limerick." },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.current_version).toBe(2);

    const revs = await db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, created.id));
    expect(revs.length).toBe(2);
    const [v1again] = await db
      .select()
      .from(skillRevisions)
      .where(and(eq(skillRevisions.skillId, created.id), eq(skillRevisions.version, 1)));
    expect(v1again!.contentHash).toBe(hashOf(created)); // immutable
    expect(v1again!.description).toBe("Always answer as a haiku.");

    // A tags-only edit does NOT mint a version.
    const tagEdit = await json<any>(`/api/skills/${created.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { tags: ["style", "fun"] },
    });
    expect(tagEdit.body.current_version).toBe(2);
    const revs2 = await db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, created.id));
    expect(revs2.length).toBe(2);
  });

  test("POST /api/runs pins the skill, keeps the prompt clean, and emits skill.loaded", async () => {
    const s = await createOrgSession("skill-run");
    const skill = await createSkill(s.cookies, {
      name: `Pin ${uid()}`,
      description: "desc",
      tags: [],
      sections: sections(["ov"], ["proc"], ["ver"]),
    });
    const expectedHash = hashOf(skill);

    const run = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "do the task", engine: "mock", skill: { id: skill.id, version: 1 } },
    });
    expect(run.status).toBe(201);
    const runId = run.body.id;

    // The stored run: clean prompt + pinned skill reference.
    const got = await json<any>(`/api/runs/${runId}`, { cookies: s.cookies });
    expect(got.body.prompt).toBe("do the task"); // NO skill text leaked in
    expect(got.body.skill_id).toBe(skill.id);
    expect(got.body.skill_version).toBe(1);
    expect(got.body.skill_content_hash).toBe(expectedHash);

    // skill.loaded landed on the durable native lane (fire-and-forget → poll).
    const row = await waitFor(async () => {
      const [r] = await db
        .select()
        .from(providerEvents)
        .where(
          and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, "skill.loaded")),
        );
      return r ?? null;
    });
    expect(row.provider).toBe("skynet");

    // …and replays on the SSE stream as a native frame carrying metadata ONLY.
    const res = await fetchApi(`/api/runs/${runId}/events`, { cookies: s.cookies });
    const events = await readSse(res, { timeoutMs: 8000 });
    const loaded = events
      .filter((e) => e.event === "native")
      .map((e) => JSON.parse(e.data))
      .find((f) => f.eventType === "skill.loaded");
    expect(loaded).toBeTruthy();
    expect(loaded.payload.skillId).toBe(skill.id);
    expect(loaded.payload.version).toBe(1);
    expect(loaded.payload.contentHash).toBe(expectedHash);
    expect(loaded.payload.source).toBe("skill");
    expect(loaded.payload.kind).toBe("skill");
    expect(loaded.payload.name).toBe(skill.name);
    // Bounded — the skill body is never in the marker.
    expect(loaded.payload).not.toHaveProperty("content");
    expect(loaded.payload).not.toHaveProperty("sections");
  });

  test("a continuation does not inherit a prior skill unless it is explicitly selected", async () => {
    const s = await createOrgSession("skill-continuation");
    const skill = await createSkill(s.cookies, {
      name: `Continuation ${uid()}`,
      description: "Only govern the turn that selected or activated this procedure.",
      tags: [],
      sections: sections(["ov"], ["proc"], ["ver"]),
    });
    const root = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "first task", engine: "mock", skill: { id: skill.id } },
    });
    expect(root.status).toBe(201);

    const reply = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "different follow-up task", engine: "mock", parent_run_id: root.body.id },
    });
    expect(reply.status).toBe(201);
    const stored = await json<any>(`/api/runs/${reply.body.id}`, { cookies: s.cookies });
    expect(stored.body.skill_id).toBeNull();
    expect(stored.body.skill_version).toBeNull();
    expect(stored.body.skill_content_hash).toBeNull();
  });

  test("a pinned PLAYBOOK emits skill.loaded with kind:playbook (marker attribution)", async () => {
    const s = await createOrgSession("pb-run");
    const playbook = await createSkill(s.cookies, {
      name: `PB ${uid()}`,
      kind: "playbook",
      description: "A structured procedure.",
      tags: [],
      sections: sections(["ov"], ["do the step"], ["confirm it"]),
    });
    expect(playbook.kind).toBe("playbook");

    const run = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "do the task", engine: "mock", skill: { id: playbook.id } },
    });
    expect(run.status).toBe(201);

    const row = await waitFor(async () => {
      const [r] = await db
        .select()
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.runId, run.body.id),
            eq(providerEvents.eventType, "skill.loaded"),
          ),
        );
      return r ?? null;
    });
    // provider_events.payload is JSON stored as text (bounded audit lane).
    const payload = JSON.parse(row.payload as string);
    expect(payload.kind).toBe("playbook");
    expect(payload.name).toBe(playbook.name);
  });

  test("editing a skill after a run does not alter the historical run's pinned version", async () => {
    const s = await createOrgSession("skill-immut");
    const skill = await createSkill(s.cookies, {
      name: `Immut ${uid()}`,
      description: "v1 desc",
      tags: [],
      sections: sections(["a"], ["b"], ["c"]),
    });
    const run = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "x", engine: "mock", skill: { id: skill.id } },
    });
    const before = await json<any>(`/api/runs/${run.body.id}`, { cookies: s.cookies });
    expect(before.body.skill_version).toBe(1);
    const hashBefore = before.body.skill_content_hash;

    await json(`/api/skills/${skill.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { description: "v2 desc — totally rewritten" },
    });

    const after = await json<any>(`/api/runs/${run.body.id}`, { cookies: s.cookies });
    expect(after.body.skill_version).toBe(1); // still v1
    expect(after.body.skill_content_hash).toBe(hashBefore); // unchanged
  });

  test("unknown skill / bad version / cross-org are fail-closed", async () => {
    const s = await createOrgSession("skill-fc");
    const other = await createOrgSession("skill-fc-other");
    const skill = await createSkill(s.cookies, {
      name: `Scoped ${uid()}`,
      description: "d",
      tags: [],
      sections: sections(["a"], ["b"], ["c"]),
    });

    const unknown = await json("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "x", engine: "mock", skill: { id: crypto.randomUUID() } },
    });
    expect(unknown.status).toBe(400);

    const badVer = await json("/api/runs", {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "x", engine: "mock", skill: { id: skill.id, version: 99 } },
    });
    expect(badVer.status).toBe(400);

    // Another org can't pin this org's skill (resolves to null → fail closed).
    const cross = await json("/api/runs", {
      method: "POST",
      cookies: other.cookies,
      body: { prompt: "x", engine: "mock", skill: { id: skill.id } },
    });
    expect(cross.status).toBe(400);
  });

  test("POST /api/skills/:id/run creates a REAL run with the skill pinned; requires a prompt", async () => {
    const s = await createOrgSession("skill-runep");
    const skill = await createSkill(s.cookies, {
      name: `RunEp ${uid()}`,
      description: "d",
      tags: [],
      sections: sections(["a"], ["b"], ["c"]),
    });

    // No prompt → 400 (no more misleading metric-only "run").
    const noPrompt = await fetchApi(`/api/skills/${skill.id}/run`, {
      method: "POST",
      cookies: s.cookies,
    });
    expect(noPrompt.status).toBe(400);

    // With prompt → a genuine run, skill pinned.
    const ran = await json<{ id: string }>(`/api/skills/${skill.id}/run`, {
      method: "POST",
      cookies: s.cookies,
      body: { prompt: "run via skill endpoint", engine: "mock" },
    });
    expect(ran.status).toBe(201);
    const got = await json<any>(`/api/runs/${ran.body.id}`, { cookies: s.cookies });
    expect(got.body.skill_id).toBe(skill.id);
    expect(got.body.skill_version).toBe(1);
    expect(got.body.prompt).toBe("run via skill endpoint");

    // Usage bumped.
    const list = await json<{ skills: any[] }>("/api/skills", { cookies: s.cookies });
    const updated = list.body.skills.find((x) => x.id === skill.id);
    expect(updated.usage_count).toBeGreaterThanOrEqual(1);

    // Cross-org → 404.
    const other = await createOrgSession("skill-runep-other");
    const cross = await json(`/api/skills/${skill.id}/run`, {
      method: "POST",
      cookies: other.cookies,
      body: { prompt: "x" },
    });
    expect(cross.status).toBe(404);
  });
});
