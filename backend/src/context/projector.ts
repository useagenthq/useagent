import type { SkillSections } from "../db/schema";
import { sql } from "../knowledge/store";
import {
  deleteContextRow,
  upsertContextRow,
  type ContextKind,
  type ContextProjection,
} from "./store";

// ---------------------------------------------------------------------------
// Projector (Phase 1) — pure builders that turn an authoritative row into a
// context_index projection, plus best-effort sync wrappers used on the write
// path of each source store. A projection failure must NEVER fail the
// underlying write, so every sync helper is wrapped + logged and swallows.
//
// source_ref is the stable typed pointer used by context_read to resolve the
// exact authoritative content:
//   skill/playbook/blueprint -> "skill:<id>@<version>" (kind carried separately)
//   knowledge                -> "knowledge:<recordId>"
//   automation               -> "automation:<scheduleId>"
//   memory                   -> "memory:<id>"
// The typed prefix is the KIND FAMILY, not the product label: playbooks and
// blueprints share the "skill:" prefix because they resolve through the same
// skills store; `kind` distinguishes them for filtering + display.
// ---------------------------------------------------------------------------

/** Concatenate title + description/body + tags into the FTS corpus. Empty parts
 *  are dropped so the tsvector stays clean. */
function buildSearchableText(parts: {
  title: string;
  body?: string;
  tags?: readonly string[];
}): string {
  const segments = [parts.title, parts.body ?? "", (parts.tags ?? []).join(" ")];
  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/** Flatten a skill's Overview/Procedure/Verify sections into a plain-text body. */
function flattenSkillSections(sections: SkillSections): string {
  return [...sections.overview, ...sections.procedure, ...sections.verify]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

export interface SkillLike {
  id: string;
  orgId: string;
  /** "skill" | "playbook" (schema SkillKind) — a "blueprint" caller may pass
   *  "blueprint" explicitly; all resolve through the skills store. */
  kind: ContextKind;
  name: string;
  description: string;
  tags: string[];
  sections: SkillSections;
  currentVersion: number;
}

export function projectSkill(skill: SkillLike): ContextProjection {
  const body = [skill.description, flattenSkillSections(skill.sections)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return {
    orgId: skill.orgId,
    kind: skill.kind,
    title: skill.name,
    searchableText: buildSearchableText({ title: skill.name, body, tags: skill.tags }),
    sourceRef: `skill:${skill.id}@${skill.currentVersion}`,
    sourceKindId: skill.id,
    version: skill.currentVersion,
    embedding: null,
  };
}

export interface KnowledgeLike {
  /** knowledge_records.id — the authoritative retrieval-row identity. */
  recordId: string;
  orgId: string;
  title: string;
  body: string;
  tags?: string[];
}

export function projectKnowledge(rec: KnowledgeLike): ContextProjection {
  return {
    orgId: rec.orgId,
    kind: "knowledge",
    title: rec.title,
    searchableText: buildSearchableText({ title: rec.title, body: rec.body, tags: rec.tags }),
    sourceRef: `knowledge:${rec.recordId}`,
    sourceKindId: rec.recordId,
    version: null,
    embedding: null,
  };
}

export interface AutomationLike {
  id: string;
  orgId: string;
  name: string;
  prompt: string;
  cron: string;
  tags?: string[];
}

export function projectAutomation(auto: AutomationLike): ContextProjection {
  const body = [auto.prompt, `cron ${auto.cron}`]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return {
    orgId: auto.orgId,
    kind: "automation",
    title: auto.name,
    searchableText: buildSearchableText({ title: auto.name, body, tags: auto.tags }),
    sourceRef: `automation:${auto.id}`,
    sourceKindId: auto.id,
    version: null,
    embedding: null,
  };
}

export interface MemoryLike {
  id: string;
  orgId: string;
  title: string;
  body: string;
  tags?: string[];
}

export function projectMemory(mem: MemoryLike): ContextProjection {
  return {
    orgId: mem.orgId,
    kind: "memory",
    title: mem.title,
    searchableText: buildSearchableText({ title: mem.title, body: mem.body, tags: mem.tags }),
    sourceRef: `memory:${mem.id}`,
    sourceKindId: mem.id,
    version: null,
    embedding: null,
  };
}

// ---------------------------------------------------------------------------
// Best-effort sync (write-path hooks). NEVER throws — a projection failure is
// logged and swallowed so it can never fail the underlying store write.
// ---------------------------------------------------------------------------

/** Project a skill/playbook/blueprint. Removes any stale prior-version row for
 *  the same skill id first (source_ref carries the version), so exactly one
 *  current row survives per authoritative skill. Idempotent + non-fatal. */
export async function syncSkillToContextIndex(skill: SkillLike): Promise<void> {
  try {
    // Clear any prior "skill:<id>@<oldVersion>" projection before writing the
    // current one, so a version bump never leaves a stale row behind.
    await sql`DELETE FROM context_index WHERE org_id = ${skill.orgId} AND source_ref LIKE ${`skill:${skill.id}@%`}`;
    await upsertContextRow(projectSkill(skill));
  } catch (err) {
    console.warn("[context] skill projection failed (non-fatal):", err);
  }
}

/** Project a published knowledge record. Idempotent + non-fatal. */
export async function syncKnowledgeToContextIndex(rec: KnowledgeLike): Promise<void> {
  try {
    await upsertContextRow(projectKnowledge(rec));
  } catch (err) {
    console.warn("[context] knowledge projection failed (non-fatal):", err);
  }
}

/** Project an automation. Idempotent + non-fatal. */
export async function syncAutomationToContextIndex(auto: AutomationLike): Promise<void> {
  try {
    await upsertContextRow(projectAutomation(auto));
  } catch (err) {
    console.warn("[context] automation projection failed (non-fatal):", err);
  }
}

/** Project a memory item. Idempotent + non-fatal. */
export async function syncMemoryToContextIndex(mem: MemoryLike): Promise<void> {
  try {
    await upsertContextRow(projectMemory(mem));
  } catch (err) {
    console.warn("[context] memory projection failed (non-fatal):", err);
  }
}

/** Remove a projection by source_ref (org-scoped) — used when the authoritative
 *  row leaves the searchable set (wiki archive, automation delete). Non-fatal. */
export async function removeFromContextIndex(orgId: string, sourceRef: string): Promise<void> {
  try {
    await deleteContextRow(orgId, sourceRef);
  } catch (err) {
    console.warn("[context] projection removal failed (non-fatal):", err);
  }
}
