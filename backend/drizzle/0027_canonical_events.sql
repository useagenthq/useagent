CREATE TABLE "canonical_events" (
	"delivery_seq" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"turn_id" text,
	"kind" text NOT NULL,
	"ts" bigint NOT NULL,
	"identity" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canonical_events" ADD CONSTRAINT "canonical_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_canonical_events_thread_delivery" ON "canonical_events" USING btree ("thread_id","delivery_seq");
--> statement-breakpoint
CREATE INDEX "idx_canonical_events_run" ON "canonical_events" USING btree ("run_id","seq");
--> statement-breakpoint
CREATE INDEX "idx_canonical_events_event" ON "canonical_events" USING btree ("event_id");
