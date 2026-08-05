import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { skills, type SkillSections } from "../db/schema";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.use("*", orgScope);

type SkillRecord = typeof skills.$inferSelect;

function toSkill(s: SkillRecord) {
  return {
    id: s.id,
    org_id: s.orgId,
    name: s.name,
    description: s.description,
    tags: s.tags,
    sections: s.sections,
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

// List all skills for the active org (newest first).
skillsRoutes.get("/", async (c) => {
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.orgId, c.get("orgId")))
    .orderBy(desc(skills.createdAt), desc(skills.id));
  return c.json({ skills: rows.map(toSkill) });
});

// Create a skill.
skillsRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const [row] = await db
    .insert(skills)
    .values({
      orgId: c.get("orgId"),
      name,
      description: typeof body.description === "string" ? body.description : "",
      tags: coerceStringArray(body.tags),
      sections: coerceSections(body.sections),
    })
    .returning();

  return c.json(toSkill(row!), 201);
});

// Update a skill (partial).
skillsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: Partial<typeof skills.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string" && body.name.trim())
    patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (body.tags !== undefined) patch.tags = coerceStringArray(body.tags);
  if (body.sections !== undefined) patch.sections = coerceSections(body.sections);

  const [row] = await db
    .update(skills)
    .set(patch)
    .where(and(eq(skills.id, id), eq(skills.orgId, c.get("orgId"))))
    .returning();

  if (!row) return c.json({ error: "skill not found" }, 404);
  return c.json(toSkill(row));
});

// Delete a skill.
skillsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, c.get("orgId"))))
    .returning({ id: skills.id });
  if (!row) return c.json({ error: "skill not found" }, 404);
  return c.json({ deleted: true, id: row.id });
});

// Run a skill: bump usage_count + last_run_at, return the updated skill.
skillsRoutes.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .update(skills)
    .set({
      usageCount: sql`${skills.usageCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(skills.id, id), eq(skills.orgId, c.get("orgId"))))
    .returning();
  if (!row) return c.json({ error: "skill not found" }, 404);
  return c.json(toSkill(row));
});
