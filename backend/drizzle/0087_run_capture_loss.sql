-- fast-deploy: expansion-safe
-- Capture-loss ledger: one row per provider frame that failed to persist even after the
-- bounded retry, keyed by (run, event id) so landing it is idempotent. The canonicalization
-- outbox reads it at seal time and marks such a run complete_degraded instead of complete.
CREATE TABLE IF NOT EXISTS "run_capture_loss" (
  "run_id" text NOT NULL,
  "event_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "event_type" text,
  "error" text,
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "run_capture_loss_pkey" PRIMARY KEY ("run_id", "event_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_capture_loss_thread" ON "run_capture_loss" ("thread_id");
