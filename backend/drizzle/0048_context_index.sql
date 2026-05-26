-- Unified Context Index (Phase 1) — ONE searchable projection over the four
-- authoritative stores (knowledge, skills/playbooks/blueprints, automations,
-- memory). The physical stores stay separate and authoritative; this table is a
-- PROJECTION/index keyed by a stable typed `source_ref` back to the real row.
--
-- The embedding column is NULLABLE and stays dormant in Phase 1 (no key, no LLM
-- call); Phase 2 fills it. It uses the SAME pgvector dim/type as the knowledge
-- store (vector(1024)) so the retrieval infra matches. pgvector is enabled at
-- runtime by the knowledge store too; enabling it here is idempotent.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	-- knowledge | skill | playbook | blueprint | automation | memory (a future
	-- "code" kind is reserved by the resolver; no schema change needed to add it).
	"kind" text NOT NULL,
	"title" text NOT NULL,
	-- Concatenated title + description/body + tags — the text FTS ranks over.
	"searchable_text" text NOT NULL,
	-- Stable typed pointer back to the authoritative row, e.g.
	-- "skill:<id>@<version>", "knowledge:<recordId>", "automation:<scheduleId>".
	"source_ref" text NOT NULL,
	-- The raw id of the authoritative row (source_ref without the typed prefix).
	"source_kind_id" text NOT NULL,
	-- Content version for skills/playbooks; null for stores without versions.
	"version" integer,
	"visibility" text DEFAULT 'org' NOT NULL,
	"embedding" vector(1024),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Source-keyed idempotent upsert target: one index row per authoritative row.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_context_index_source" ON "context_index" ("org_id", "source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_context_index_org_kind" ON "context_index" ("org_id", "kind");
--> statement-breakpoint
-- Postgres FTS: a GIN index over the tsvector of searchable_text. Expression
-- index (not a stored generated column) so the projector writes plain text and
-- ts_rank/@@ read the derived vector.
CREATE INDEX IF NOT EXISTS "idx_context_index_fts" ON "context_index" USING GIN (to_tsvector('english', "searchable_text"));
