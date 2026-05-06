CREATE TABLE "commands" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text,
	"org_id" text,
	"actor_id" text,
	"kind" text NOT NULL,
	"run_id" text,
	"thread_id" text,
	"payload_fingerprint" text,
	"payload" text,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_commands_idem" ON "commands" USING btree ("org_id","idempotency_key") WHERE "commands"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "idx_commands_run" ON "commands" USING btree ("run_id");
