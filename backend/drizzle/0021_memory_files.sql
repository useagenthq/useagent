CREATE TABLE "memory_files" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"pool_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_memory_files_pool" ON "memory_files" USING btree ("team_id","pool_user_id","created_at");
