import { z } from "zod";

/**
 * Distillation schema — ported from the knowledge service
 * (packages/distillation/src/schema.ts), adapted to zod v4 (looser string
 * validators so slightly-off model output isn't rejected outright) and to
 * Postgres storage. The domain-neutral RecordKind is the heart of the port:
 * knowledge keeps its natural shape instead of being forced into Q&A.
 */

/** Where the record came from (drives the prompt family, not the content shape). */
export const SourceType = z.enum([
  "conversation", // Slack / chat threads
  "document", // Outline / wiki / doc sections
  "code-change", // PRs / issues / reviews
  "code-artifact", // source files / code docs
  "data-asset", // BigQuery tables / views / dashboards
  "agent-outcome", // verified agent-platform outcomes
]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * The SHAPE of the knowledge, independent of domain. This is the key to
 * generality: a policy, a definition, and a troubleshooting answer are all
 * valuable knowledge but are not "resolutions" — forcing them into a Q&A shape
 * loses information. Works the same for engineering, GTM, ops, or finance.
 */
export const RecordKind = z.enum([
  "qa", // a question and its answer (troubleshooting, "how do I…")
  "reference", // how something works / an explanation
  "policy", // rules, norms, requirements ("must / should")
  "definition", // what a term or entity is
  "decision", // a choice that was made, and why
  "outcome", // a verified result of work done
]);
export type RecordKind = z.infer<typeof RecordKind>;

/**
 * Record status. The first four are model-chosen (see prompts). "undistilled"
 * is a code-only marker used when no LLM key is present and the record is a
 * stub — it never appears in the model's function-tool enum.
 */
export const Status = z.enum([
  "current",
  "unresolved",
  "superseded",
  "draft",
  "undistilled",
]);
export type Status = z.infer<typeof Status>;

/** What the model emits. Domain-neutral. Grounded fields are validated after. */
export const DistilledRecord = z.object({
  kind: RecordKind,
  status: Status,
  title: z.string().min(1).max(400), // short human-readable title
  question: z.string().min(1).max(800), // the one line someone would search for
  summary: z.string().min(1).max(4000), // 1–3 sentence gist
  // the substance in the source's own terms: the answer, explanation, rules,
  // definition, or rationale. Named neutrally — not "resolution".
  body: z.string().min(1).max(60000),
  // named things referenced, any domain: systems, tables, teams, products,
  // metrics, people, documents.
  entities: z.array(z.string().min(1)).max(200).default([]),
  // anchor ids that MUST appear verbatim in the source (message ts, url slug,
  // file path, table name, PR/ticket id). Non-empty strings only.
  refs: z.array(z.string().min(1)).max(200).default([]),
  // exact substrings a searcher might paste (a term, value, error string,
  // command, code symbol, number).
  verbatim_signals: z.array(z.string().min(1)).max(200).default([]),
  confidence: z.number().min(0).max(1),
  valid_from: z.string().nullable().default(null),
  valid_until: z.string().nullable().default(null),
});
export type DistilledRecord = z.infer<typeof DistilledRecord>;

/** Connector-owned metadata. Deterministic code fills this, never the model. */
export const SourceMeta = z.object({
  source_type: SourceType,
  external_id: z.string().min(1), // stable external identity (thread ts, repo/pr id, doc id)
  connector_instance_id: z.string().min(1), // "slack:prod", "seed:frontend"
  source_url: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  created_at: z.string(), // ISO8601 (validated loosely — connector-supplied)
  scope: z.string().default("org"), // finer access boundary
  domain: z.string().nullable().default(null), // "engineering" | "gtm" | …
});
export type SourceMeta = z.infer<typeof SourceMeta>;

/** The distillation output: the record plus grounding diagnostics + salience. */
export interface KnowledgeRecord {
  meta: SourceMeta;
  record: DistilledRecord;
  /** Grounding diagnostics — how many refs/signals were dropped as ungrounded. */
  grounding: { refsDropped: number; signalsDropped: number };
  /** LLM salience verdict: is this durable, reusable knowledge worth keeping? */
  worthSaving: boolean;
  /** True when this is a keyless stub (no distillation LLM was called). */
  stub: boolean;
}
