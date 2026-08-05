CREATE TABLE "provider_events" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "runs"("id"),
  "thread_id" text NOT NULL,
  "seq" integer NOT NULL,
  "provider" text NOT NULL,
  "event_type" text NOT NULL,
  "native_session_id" text,
  "native_parent_session_id" text,
  "native_message_id" text,
  "native_part_id" text,
  "native_call_id" text,
  "payload" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "idx_provider_events_run" ON "provider_events" ("run_id","seq");
CREATE INDEX "idx_provider_events_part" ON "provider_events" ("native_part_id");
