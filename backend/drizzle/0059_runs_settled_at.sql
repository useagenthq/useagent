ALTER TABLE "runs" ADD COLUMN "settled_at" timestamp with time zone;

UPDATE "runs"
SET "settled_at" = "updated_at"
WHERE "status" IN ('completed', 'failed')
  AND "settled_at" IS NULL;

CREATE INDEX "idx_runs_org_settled" ON "runs" USING btree ("org_id","settled_at","id");
