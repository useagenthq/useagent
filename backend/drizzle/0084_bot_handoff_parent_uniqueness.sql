-- fast-deploy: expansion-safe
-- Keep the earliest attribution if a pre-constraint race created duplicates.
-- This is backward compatible with the active reader, which already chooses
-- the earliest attribution as the canonical delegated thread.
DELETE FROM "bot_handoffs" AS duplicate
USING "bot_handoffs" AS winner
WHERE duplicate."org_id" = winner."org_id"
	AND duplicate."bot_id" = winner."bot_id"
	AND duplicate."parent_thread_id" = winner."parent_thread_id"
	AND (duplicate."created_at", duplicate."thread_id") > (winner."created_at", winner."thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_handoffs_parent_bot" ON "bot_handoffs" ("org_id", "bot_id", "parent_thread_id");
