ALTER TABLE "schedules" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "schedule_firings" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_firings_idem" ON "schedule_firings" USING btree ("idempotency_key");
