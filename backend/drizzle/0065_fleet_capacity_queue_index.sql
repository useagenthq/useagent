-- fast-deploy: expansion-safe
CREATE INDEX "idx_run_admissions_capacity_queue"
ON "run_admissions" USING btree ("state", "priority" DESC, "queued_at" ASC, "run_id" ASC)
WHERE "state" = 'queued'
  AND "queue_reason" IN ('provider_capacity', 'global_limit', 'org_limit');
