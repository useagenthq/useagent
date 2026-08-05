CREATE TABLE "memory_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payload" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_memory_outbox_due" ON "memory_outbox" USING btree ("state","next_attempt_at");