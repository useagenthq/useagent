-- Phase 3: a VALIDATED native provider command turn records the command NAME here, so the
-- worker (composeTurnPrompt) delivers the run's prompt byte-verbatim with no injected context.
-- Additive + nullable: every ordinary prompt leaves it null and keeps the full context prefix.
ALTER TABLE "runs" ADD COLUMN "command_name" text;
