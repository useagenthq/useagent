CREATE INDEX "idx_runs_org_updated" ON "runs" USING btree ("org_id","updated_at","id");
