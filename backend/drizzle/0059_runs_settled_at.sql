-- fast-deploy: expansion-safe
ALTER TABLE "runs" ADD COLUMN "settled_at" timestamp with time zone;

CREATE INDEX "idx_runs_org_settled" ON "runs" USING btree ("org_id","settled_at","id");
