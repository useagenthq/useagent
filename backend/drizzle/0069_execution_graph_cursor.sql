-- Execution-graph READ remains disabled during this expansion. Provider delivery
-- sequence is shared by every target edge emitted from one control event; a
-- database sequence is the stable insertion cursor required for lossless paging.
ALTER TABLE "delegation_edges"
ADD COLUMN "cursor_seq" bigserial NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_delegation_edges_cursor"
ON "delegation_edges" USING btree ("org_id", "run_id", "cursor_seq");
