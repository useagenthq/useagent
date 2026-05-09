CREATE TABLE "canonicalization_outbox" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"source_frame_max" integer,
	"source_step_count" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canonicalization_outbox" ADD CONSTRAINT "canonicalization_outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_canon_outbox_due" ON "canonicalization_outbox" USING btree ("state","next_attempt_at");
