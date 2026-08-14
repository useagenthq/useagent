CREATE TABLE "user_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_user_uploads_owner_created" ON "user_uploads" USING btree ("org_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_user_uploads_run" ON "user_uploads" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_user_uploads_expires" ON "user_uploads" USING btree ("expires_at");
