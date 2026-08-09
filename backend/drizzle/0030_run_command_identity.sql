-- C3 (fail-closed command authorization): persist the ACCEPTED command IDENTITY alongside the
-- name, not only command_name - which provider, native session, and catalog snapshot revision
-- authorized the command. Lets the worker re-validate against the LIVE session before sending
-- and records exactly what was authorized. All additive + nullable (null for a non-command run).
ALTER TABLE "runs" ADD COLUMN "command_provider" text;
ALTER TABLE "runs" ADD COLUMN "command_session_id" text;
ALTER TABLE "runs" ADD COLUMN "command_catalog_revision" bigint;
