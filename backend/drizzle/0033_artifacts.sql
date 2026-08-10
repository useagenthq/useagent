CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"source_path" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifacts_run_path_sha" ON "artifacts" USING btree ("run_id","source_path","sha256");
--> statement-breakpoint
CREATE INDEX "idx_artifacts_org_created" ON "artifacts" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_artifacts_thread_created" ON "artifacts" USING btree ("thread_id","created_at");
