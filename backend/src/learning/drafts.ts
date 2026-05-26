import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  artifacts,
  knowledgeDrafts,
  runs,
  steps,
  type KnowledgeDraftEvidence,
  type KnowledgeDraftReason,
  type KnowledgeDraftStatus,
} from "../db/schema";
import { contentHash } from "../knowledge/distill";
import { embeddingsEnabled, embedOne } from "../knowledge/embed";
import { upsertRecord } from "../knowledge/store";
import { buildProcedureTrace } from "../memory/procedure-trace";
import { orgSecretRedactor } from "../secrets/store";
import { maybeProposeSkillRevision } from "./proposals";
import { highValueReason } from "./salience";

// ---------------------------------------------------------------------------
// Knowledge drafts (item 4) — the reviewable learning lane. The producer runs
// AFTER a run finalizes: a high-value completed run proposes a DRAFT row here,
// and NOTHING else. A knowledge_records row (agent-searchable truth) is created
// only by an explicit org-admin accept, through the existing store upsert —
// the same path wiki publishing uses. Dismissals are recorded, never deleted.
// ---------------------------------------------------------------------------

export type KnowledgeDraftRecord = typeof knowledgeDrafts.$inferSelect;

const TITLE_CAP = 120;

/** Draft title: the prompt's first non-empty line, whitespace-collapsed and
 *  capped. Pure. */
export function draftTitleFromPrompt(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "Untitled run";
  return line.replace(/\s+/g, " ").slice(0, TITLE_CAP).trim();
}

/** The proposed knowledge body (markdown), assembled deterministically from
 *  what the run durably recorded. Pure. */
export function buildDraftContent(input: {
  prompt: string;
  summary: string;
  reason: KnowledgeDraftReason;
  artifactNames: string[];
}): string {
  const lines: string[] = ["## Task", "", input.prompt.trim(), "", "## Outcome", ""];
  lines.push(input.summary.trim() || "(no summary recorded)");
  if (input.artifactNames.length > 0) {
    lines.push("", "## Published artifacts", "");
    for (const name of input.artifactNames) lines.push(`- ${name}`);
  }
  lines.push(
    "",
    "## Why this was captured",
    "",
    input.reason === "published_artifacts"
      ? "The run published durable artifacts."
      : "The run was a long multi-tool session.",
  );
  return lines.join("\n") + "\n";
}

/**
 * Post-finalize producer: propose a knowledge DRAFT for a completed high-value
 * run. Idempotent per run (unique run_id, onConflictDoNothing) — re-finalizing
 * or replaying never duplicates a draft. Returns the created row, or null when
 * the run is missing / not completed / not org-scoped / not high-value / already
 * drafted. Never writes knowledge_records.
 */
export async function proposeKnowledgeDraftForRun(
  runId: string,
): Promise<KnowledgeDraftRecord | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run || run.status !== "completed" || !run.orgId) return null;

  const artifactRows = await db
    .select({ name: artifacts.name })
    .from(artifacts)
    .where(eq(artifacts.runId, runId));
  const stepRows = await db
    .select({ kind: steps.kind, label: steps.label, chip: steps.chip, codeJson: steps.codeJson })
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(asc(steps.idx));
  const distinctStepKinds = new Set(stepRows.map((r) => r.kind)).size;

  const reason = highValueReason({
    status: run.status,
    artifactCount: artifactRows.length,
    stepCount: stepRows.length,
    distinctStepKinds,
  });
  if (!reason) return null;

  // The ordered executable trace (bounded, redacted) — the step labels were
  // already redacted at capture time; the org redactor here is defense in depth
  // for anything replayed or reconciled into the log after the fact.
  const trace = buildProcedureTrace(stepRows, await orgSecretRedactor(run.orgId));

  const artifactNames = artifactRows.map((r) => r.name);
  const evidence: KnowledgeDraftEvidence = {
    reason,
    engine: run.engine,
    model: run.model,
    durationMs: run.durationMs,
    stepCount: stepRows.length,
    distinctStepKinds,
    artifactCount: artifactRows.length,
    artifactNames,
    ...(trace.steps.length > 0 ? { procedure: trace.steps } : {}),
    ...(trace.elided > 0 ? { procedureElided: trace.elided } : {}),
  };
  const [row] = await db
    .insert(knowledgeDrafts)
    .values({
      orgId: run.orgId,
      runId,
      threadId: run.threadId,
      title: draftTitleFromPrompt(run.prompt),
      content: buildDraftContent({
        prompt: run.prompt,
        summary: run.summary ?? "",
        reason,
        artifactNames,
      }),
      evidence,
    })
    .onConflictDoNothing({ target: knowledgeDrafts.runId })
    .returning();
  return row ?? null;
}

/** List an org's drafts, newest first; optional status filter. */
export async function listKnowledgeDrafts(
  orgId: string,
  status?: KnowledgeDraftStatus,
  limit = 200,
): Promise<KnowledgeDraftRecord[]> {
  return db
    .select()
    .from(knowledgeDrafts)
    .where(
      status
        ? and(eq(knowledgeDrafts.orgId, orgId), eq(knowledgeDrafts.status, status))
        : eq(knowledgeDrafts.orgId, orgId),
    )
    .orderBy(desc(knowledgeDrafts.createdAt), desc(knowledgeDrafts.id))
    .limit(limit);
}

export type AcceptDraftResult =
  | { ok: true; draft: KnowledgeDraftRecord; recordId: string; proposalId: string | null }
  | { ok: false; error: "not_found" | "not_open" };

/**
 * Accept a draft (org-admin only — enforced at the route): atomically claim it
 * (draft → accepted, guarded on status so a concurrent accept loses), then
 * create the REAL knowledge record through the existing store upsert (keyed by
 * `learning:<draftId>`, so a crash-retry replaces in place rather than
 * duplicating). If the record write fails the claim is reverted. Finally, the
 * accepted draft may raise a skill revision proposal (item 6) — that step is
 * best-effort and can never undo the accept.
 */
export async function acceptKnowledgeDraft(
  orgId: string,
  draftId: string,
  userId: string | null,
): Promise<AcceptDraftResult> {
  const [draft] = await db
    .update(knowledgeDrafts)
    .set({
      status: "accepted",
      resolvedBy: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeDrafts.id, draftId),
        eq(knowledgeDrafts.orgId, orgId),
        eq(knowledgeDrafts.status, "draft"),
      ),
    )
    .returning();
  if (!draft) return { ok: false, error: await missingReason(orgId, draftId) };

  // Embedding is optional (keyless → keyword-only), never a failure.
  const embedding = embeddingsEnabled()
    ? await embedOne(`${draft.title}\n\n${draft.content}`).catch(() => null)
    : null;

  let recordId: string;
  try {
    recordId = await upsertRecord({
      orgId,
      userId,
      kind: "learning",
      title: draft.title,
      body: draft.content,
      refs: [],
      meta: {
        source_type: "learning",
        draft_id: draft.id,
        run_id: draft.runId,
        thread_id: draft.threadId,
        reason: draft.evidence.reason,
        status: "accepted",
      },
      externalId: `learning:${draft.id}`,
      connectorInstanceId: "learning",
      contentHash: contentHash(draft.content),
      distillationKey: `learning:${contentHash(draft.content)}`,
      worthSaving: true,
      embedding,
    });
  } catch (err) {
    // Revert the claim so the draft stays reviewable instead of stranding as
    // "accepted" with no record behind it.
    await db
      .update(knowledgeDrafts)
      .set({ status: "draft", resolvedBy: null, resolvedAt: null, updatedAt: new Date() })
      .where(and(eq(knowledgeDrafts.id, draftId), eq(knowledgeDrafts.orgId, orgId)));
    throw err;
  }

  await db
    .update(knowledgeDrafts)
    .set({ acceptedRecordId: recordId, updatedAt: new Date() })
    .where(eq(knowledgeDrafts.id, draftId));
  draft.acceptedRecordId = recordId;

  // Item 6: a repeated procedure raises a skill revision PROPOSAL (still
  // human-gated). Best-effort — a failure here never undoes the accept.
  let proposalId: string | null = null;
  try {
    proposalId = await maybeProposeSkillRevision(draft);
  } catch (err) {
    console.error("[learning] skill proposal failed:", (err as Error).message);
  }

  return { ok: true, draft, recordId, proposalId };
}

/** Dismiss a draft (recorded, never deleted). Guarded on status="draft". */
export async function dismissKnowledgeDraft(
  orgId: string,
  draftId: string,
  userId: string | null,
): Promise<{ ok: true; draft: KnowledgeDraftRecord } | { ok: false; error: "not_found" | "not_open" }> {
  const [draft] = await db
    .update(knowledgeDrafts)
    .set({
      status: "dismissed",
      resolvedBy: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeDrafts.id, draftId),
        eq(knowledgeDrafts.orgId, orgId),
        eq(knowledgeDrafts.status, "draft"),
      ),
    )
    .returning();
  if (!draft) return { ok: false, error: await missingReason(orgId, draftId) };
  return { ok: true, draft };
}

/** Distinguish "no such draft in this org" (404) from "already resolved" (409). */
async function missingReason(orgId: string, draftId: string): Promise<"not_found" | "not_open"> {
  const [existing] = await db
    .select({ id: knowledgeDrafts.id })
    .from(knowledgeDrafts)
    .where(and(eq(knowledgeDrafts.id, draftId), eq(knowledgeDrafts.orgId, orgId)))
    .limit(1);
  return existing ? "not_open" : "not_found";
}
