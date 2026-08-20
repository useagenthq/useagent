-- Learning outbox (self_improving 6.1) — the DURABLE learning intent. A run's
-- learning candidate used to be built AFTER finalizeRun committed (a crash in
-- that gap lost it, and re-finalize / boot-reconcile never re-armed it). This
-- row is written INSIDE the finalization transaction for every eligible
-- completed run, so "completed => learning intent enqueued" holds atomically. A
-- boot-started worker (src/learning/learning-outbox.ts) claims pending rows,
-- builds the evidence-backed candidate (verified-outcome gate, 6.4), and writes
-- the knowledge_draft — retryable, dead-lettering with an operator-visible
-- reason, and it NEVER fails the already-completed run.
--
-- Idempotent by run_id (PK): one learning candidate per run. AT-LEAST-once —
-- candidate building is idempotent (knowledge_drafts.uq_knowledge_drafts_run),
-- so a crash-orphaned `processing` row is safely reset to `pending` at boot.
CREATE TABLE IF NOT EXISTS "learning_outbox" (
	"run_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"memory_scope" text DEFAULT 'org' NOT NULL,
	"origin" text,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The worker claims due rows by (status, next_attempt_at).
CREATE INDEX IF NOT EXISTS "idx_learning_outbox_due" ON "learning_outbox" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_learning_outbox_org" ON "learning_outbox" ("org_id");
