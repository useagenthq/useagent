import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  ENGINE_IDS,
  SKILL_KINDS,
  skills,
  type EngineId,
  type SkillKind,
  type SkillSections,
} from "../db/schema";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { acceptRunCommand } from "../commands";
import { pumpThread } from "../worker";
import {
  bumpSkillUsage,
  createSkillWithRevision,
  resolveSkillSelection,
  updateSkillWithRevision,
  type SkillRecord,
} from "./repo";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.use("*", orgScope);

function toSkill(s: SkillRecord) {
  return {
    id: s.id,
    org_id: s.orgId,
    name: s.name,
    // "skill" | "playbook" — same substrate, two product surfaces.
    kind: s.kind,
    description: s.description,
    tags: s.tags,
    sections: s.sections,
    // The skill's current immutable revision — the version a new run pins.
    current_version: s.currentVersion,
    usage_count: s.usageCount,
    last_run_at: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

function coerceStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function coerceSections(v: unknown): SkillSections {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    overview: coerceStringArray(o.overview),
    procedure: coerceStringArray(o.procedure),
    verify: coerceStringArray(o.verify),
  };
}

// List skills for the active org (newest first). An optional `?kind=` filter
// splits the shared substrate into its two product surfaces (Skills vs
// Playbooks pages); omitted → every kind. An unknown kind yields an empty list.
skillsRoutes.get("/", async (c) => {
  const kindParam = c.req.query("kind");
  const kindFilter =
    kindParam && (SKILL_KINDS as readonly string[]).includes(kindParam)
      ? (kindParam as SkillKind)
      : null;
  const where = kindFilter
    ? and(eq(skills.orgId, c.get("orgId")), eq(skills.kind, kindFilter))
    : kindParam
      ? // an explicit but unrecognized kind matches nothing (fail closed)
        sql`false`
      : eq(skills.orgId, c.get("orgId"));
  const rows = await db
    .select()
    .from(skills)
    .where(where)
    .orderBy(desc(skills.createdAt), desc(skills.id));
  return c.json({ skills: rows.map(toSkill) });
});

// Create a skill AND its version-1 revision (one transaction).
skillsRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  // `kind` classifies the row as a plain skill (default) or a playbook. An
  // explicit unknown value is a client error, matching the engine check below.
  let kind: SkillKind = "skill";
  if (body.kind !== undefined) {
    if (
      typeof body.kind !== "string" ||
      !(SKILL_KINDS as readonly string[]).includes(body.kind)
    ) {
      return c.json({ error: `kind must be one of: ${SKILL_KINDS.join(", ")}` }, 400);
    }
    kind = body.kind as SkillKind;
  }

  const row = await createSkillWithRevision({
    orgId: c.get("orgId"),
    name,
    kind,
    description: typeof body.description === "string" ? body.description : "",
    tags: coerceStringArray(body.tags),
    sections: coerceSections(body.sections),
  });
  if (!row) return c.json({ error: "a skill with that name already exists" }, 409);
  return c.json(toSkill(row), 201);
});

// Update a skill (partial). A content change (name/description/sections) bumps
// current_version and appends a new immutable revision — old runs, pinned to
// their version, are never mutated. A tags-only edit doesn't mint a version.
skillsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: {
    name?: string;
    description?: string;
    tags?: string[];
    sections?: SkillSections;
  } = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (body.tags !== undefined) patch.tags = coerceStringArray(body.tags);
  if (body.sections !== undefined) patch.sections = coerceSections(body.sections);

  const row = await updateSkillWithRevision(c.get("orgId"), id, patch);
  if (!row) return c.json({ error: "skill not found" }, 404);
  return c.json(toSkill(row));
});

// Delete a skill (revisions cascade). A historical run keeps its own recorded
// skill_id/version/hash for provenance even after the skill is gone.
skillsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, c.get("orgId"))))
    .returning({ id: skills.id });
  if (!row) return c.json({ error: "skill not found" }, 404);
  return c.json({ deleted: true, id: row.id });
});

// Run a skill: create a REAL run through the durable command lane with the skill
// pinned to its current version (mem_op 0.1 — no more misleading metric-only
// "run"). Requires a `prompt` (the task the skill governs); bumps usage on accept.
skillsRoutes.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown> = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Resolve + pin the skill's current version, org-scoped FIRST (fail closed →
  // 404) so a cross-org id is indistinguishable from missing, before any other
  // validation could leak its existence.
  const pinned = await resolveSkillSelection(c.get("orgId"), { id });
  if (!pinned) return c.json({ error: "skill not found" }, 404);

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return c.json(
      { error: "prompt is required to run a skill (a skill governs a task)" },
      400,
    );
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "claude-opus-5";
  // Engine is optional; default to the scripted `mock`. An explicit unknown value
  // is a client error, matching POST /api/runs.
  let engine: EngineId = "mock";
  if (body.engine !== undefined) {
    if (
      typeof body.engine !== "string" ||
      !(ENGINE_IDS as readonly string[]).includes(body.engine)
    ) {
      return c.json({ error: `engine must be one of: ${ENGINE_IDS.join(", ")}` }, 400);
    }
    engine = body.engine as EngineId;
  }

  const runId = crypto.randomUUID();
  const accepted = await acceptRunCommand({
    idempotencyKey: c.req.header("Idempotency-Key")?.trim() || null,
    orgId: c.get("orgId"),
    actorId: c.get("userId"),
    run: {
      id: runId,
      prompt,
      model,
      engine,
      parentRunId: null,
      threadId: runId,
      // Skill runs are bare-workdir, organization-scoped fresh roots (like a
      // scheduled firing) — the branch's multi-repo + memory-scope command shape.
      repos: [],
      memoryScope: "org",
      skillId: pinned.skillId,
      skillVersion: pinned.version,
      skillContentHash: pinned.contentHash,
      // A skill "Run" applies a versioned product skill; it is never a native provider command.
      commandName: null,
    },
  });
  if (accepted.status === "conflict") {
    return c.json({ error: "idempotency_key_reused", reason: accepted.reason }, 409);
  }
  if (accepted.status === "created") await pumpThread(accepted.runId);
  await bumpSkillUsage(c.get("orgId"), id);
  return c.json({ id: accepted.runId }, accepted.status === "created" ? 201 : 200);
});
