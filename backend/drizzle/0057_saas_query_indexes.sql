CREATE INDEX "idx_runs_org_created" ON "runs" USING btree ("org_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "idx_runs_org_parent_created" ON "runs" USING btree ("org_id", "parent_run_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "idx_runs_org_thread_created" ON "runs" USING btree ("org_id", "thread_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "idx_provider_events_type_run" ON "provider_events" USING btree ("event_type", "run_id");
--> statement-breakpoint
CREATE INDEX "idx_integration_connections_connected_org" ON "integration_connections" USING btree ("org_id", "runtime_binding_id", "provider") WHERE "owner_type" = 'org' AND "status" = 'connected';
--> statement-breakpoint
CREATE INDEX "idx_schedules_org_created" ON "schedules" USING btree ("org_id", "created_at", "id");
