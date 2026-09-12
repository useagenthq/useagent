-- fast-deploy: expansion-safe
-- Capture-loss ledger: one row per run that lost at least one provider frame at capture
-- (the write failed after the bounded retry). The canonicalization outbox reads it at
-- seal time and marks such a run complete_degraded instead of complete.
CREATE TABLE IF NOT EXISTS "run_capture_loss" (
  "run_id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "lost_frames" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "first_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_capture_loss_thread" ON "run_capture_loss" ("thread_id");
