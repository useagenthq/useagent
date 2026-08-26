import { devModeEnabled } from "../env";
import { env } from "./env";
import {
  contentHash,
  distill,
  distillationKey,
  PROMPT_VERSION,
  renderCanonical,
  SourceMeta,
  stubRecord,
  type KnowledgeRecord,
  type SourceMeta as SourceMetaT,
} from "./distill";
import { embedOne } from "./embed";
import { findExisting, upsertRecord } from "./store";

/**
 * Ingestion — part of the knowledge service's idempotent write path
 * (packages/ingestion). One source item in; dedupe by distillation_key
 * (content hash + source_type + prompt/model/schema version), distill, embed,
 * upsert. Same identity + unchanged recipe → skip (no re-distill). Changed →
 * re-distill + replace. worth_saving=false → dropped (never stored).
 */

export type IngestStatus = "stored" | "skipped" | "dropped" | "deferred";

export interface IngestResult {
  id: string | null;
  status: IngestStatus;
  kind: string;
  stub: boolean;
  grounding?: { refsDropped: number; signalsDropped: number };
  worthSaving: boolean;
}

export interface IngestInput {
  meta: unknown; // validated against SourceMeta below
  text: unknown;
  org_id?: string | null;
  user_id?: string | null;
}

/** Distill, but never let a transient LLM failure fail the ingest — fall back to a stub. */
async function distillOrStub(meta: SourceMetaT, text: string): Promise<KnowledgeRecord> {
  try {
    return await distill(meta, text);
  } catch (e) {
    console.warn("[knowledge] distill failed, storing stub:", (e as Error).message);
    return stubRecord(meta, text);
  }
}

/** Embed, but never let an embedding failure fail the ingest — degrade to keyword-only. */
async function embedOrNull(text: string): Promise<number[] | null> {
  try {
    return await embedOne(text);
  } catch (e) {
    console.warn("[knowledge] embed failed, storing without vector:", (e as Error).message);
    return null;
  }
}

/** Ingest one source item. Returns {id, status, kind}. Throws only on invalid input. */
export async function ingestOne(input: IngestInput): Promise<IngestResult> {
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new IngestValidationError("`text` is required and must be a non-empty string");
  }
  const rawMeta =
    input.meta && typeof input.meta === "object" ? { ...(input.meta as Record<string, unknown>) } : {};
  // created_at is connector-supplied; default to now so a caller can omit it.
  if (typeof rawMeta.created_at !== "string" || rawMeta.created_at.length === 0) {
    rawMeta.created_at = new Date().toISOString();
  }
  const parsed = SourceMeta.safeParse(rawMeta);
  if (!parsed.success) throw new IngestValidationError(`invalid meta: ${parsed.error.message}`);
  const meta = parsed.data;
  const text = input.text;

  // Org is ALWAYS server-resolved by the caller (route context or a trusted
  // boot seed) — never a header/body value and never an ambient default. Fail
  // closed rather than silently writing to a fallback tenant.
  const orgId = input.org_id ? String(input.org_id) : "";
  if (!orgId) throw new IngestValidationError("org could not be resolved for this request");
  const userId = input.user_id ? String(input.user_id) : null;

  const hash = contentHash(text);
  const dkey = distillationKey(hash, meta.source_type);

  // Idempotency: same identity + unchanged recipe → skip (no re-distill).
  const existing = await findExisting(orgId, meta.connector_instance_id, meta.external_id);
  if (existing && existing.distillation_key === dkey) {
    return { id: existing.id, status: "skipped", kind: existing.kind, stub: false, worthSaving: true };
  }

  const knowledge = await distillOrStub(meta, text);

  // Fail-closed on distillation failure/absence. A stub means the LLM was
  // unavailable (keyless) or errored, so the record is undistilled. In dev we
  // keep the stub (searchable, status:'undistilled', worth_saving true) for a
  // frictionless local loop; in production we store NOTHING and report
  // 'deferred' so a caller can retry once distillation is healthy.
  if (knowledge.stub && !devModeEnabled()) {
    return {
      id: null,
      status: "deferred",
      kind: knowledge.record.kind,
      stub: true,
      grounding: knowledge.grounding,
      worthSaving: knowledge.worthSaving,
    };
  }

  // worth_saving gate — low-value items are dropped before they reach the store.
  if (!knowledge.worthSaving) {
    return {
      id: null,
      status: "dropped",
      kind: knowledge.record.kind,
      stub: knowledge.stub,
      grounding: knowledge.grounding,
      worthSaving: false,
    };
  }

  const canonical = renderCanonical(knowledge);
  const embedding = await embedOrNull(canonical);
  const r = knowledge.record;

  const metaJson = {
    source_type: meta.source_type,
    source_url: meta.source_url,
    author: meta.author,
    created_at: meta.created_at,
    scope: meta.scope,
    domain: meta.domain,
    question: r.question,
    summary: r.summary,
    entities: r.entities,
    verbatim_signals: r.verbatim_signals,
    status: r.status,
    confidence: r.confidence,
    valid_from: r.valid_from,
    valid_until: r.valid_until,
    grounding: knowledge.grounding,
    prompt_version: PROMPT_VERSION,
    model: env.distill.model,
    stub: knowledge.stub,
  };

  const id = await upsertRecord({
    orgId,
    userId,
    kind: r.kind,
    title: r.title,
    body: r.body,
    refs: r.refs,
    meta: metaJson,
    externalId: meta.external_id,
    connectorInstanceId: meta.connector_instance_id,
    contentHash: hash,
    distillationKey: dkey,
    worthSaving: knowledge.worthSaving,
    embedding,
  });

  return {
    id,
    status: "stored",
    kind: r.kind,
    stub: knowledge.stub,
    grounding: knowledge.grounding,
    worthSaving: true,
  };
}

export class IngestValidationError extends Error {}
