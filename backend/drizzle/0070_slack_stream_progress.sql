-- Native Slack streaming progress: how many narration chars the stream has
-- ACCEPTED. Orders narration appends (each row carries its expected offset) and
-- lets stopStream append exactly the un-streamed tail of the reply.
ALTER TABLE "slack_run_responses"
ADD COLUMN "streamed_chars" integer NOT NULL DEFAULT 0;
