CREATE TABLE "slack_threads" (
	"channel" text NOT NULL,
	"thread_ts" text NOT NULL,
	"root_run_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_threads_channel_thread_ts_pk" PRIMARY KEY("channel","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_root_run_id_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;