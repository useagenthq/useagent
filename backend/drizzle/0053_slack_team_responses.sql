ALTER TABLE "slack_threads" ADD COLUMN "team_id" text;

UPDATE "slack_threads"
SET "team_id" = '__legacy__'
WHERE "team_id" IS NULL;

ALTER TABLE "slack_threads" ALTER COLUMN "team_id" SET NOT NULL;
ALTER TABLE "slack_threads" DROP CONSTRAINT "slack_threads_channel_thread_ts_pk";
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_team_id_channel_thread_ts_pk" PRIMARY KEY("team_id","channel","thread_ts");

CREATE TABLE IF NOT EXISTS "slack_run_responses" (
  "run_id" text NOT NULL,
  "team_id" text NOT NULL,
  "channel" text NOT NULL,
  "thread_ts" text NOT NULL,
  "native_stream_ts" text,
  "native_stream_mode" text,
  "fallback_message_ts" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "slack_run_responses_run_id_team_id_channel_thread_ts_pk" PRIMARY KEY("run_id","team_id","channel","thread_ts")
);

ALTER TABLE "slack_run_responses"
  ADD CONSTRAINT "slack_run_responses_run_id_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "idx_slack_run_responses_run" ON "slack_run_responses" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "idx_slack_run_responses_thread" ON "slack_run_responses" USING btree ("team_id","channel","thread_ts");

INSERT INTO "slack_run_responses" (
  "run_id",
  "team_id",
  "channel",
  "thread_ts",
  "fallback_message_ts"
)
SELECT
  "root_run_id",
  "team_id",
  "channel",
  "thread_ts",
  "card_ts"
FROM "slack_threads"
ON CONFLICT DO NOTHING;
