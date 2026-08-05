ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thread_id" text;--> statement-breakpoint
UPDATE "runs" SET "thread_id" = "id" WHERE "thread_id" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_runs_thread" ON "runs" USING btree ("thread_id");