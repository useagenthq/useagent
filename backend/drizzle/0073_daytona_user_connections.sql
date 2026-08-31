-- fast-deploy: expansion-safe
-- Add a tenant-scoped Daytona connection without changing run routing.
-- New checks are enforced for new/changed rows immediately. They remain
-- NOT VALID so this release does no table scan while holding Drizzle's
-- migration transaction; a later online validation can run independently.
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_provider_check_v2"
  CHECK ("provider" IN ('openai', 'anthropic', 'openrouter', 'daytona')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  DROP CONSTRAINT "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  RENAME CONSTRAINT "provider_connections_provider_check_v2"
  TO "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_daytona_auth_check" CHECK (
    "provider" <> 'daytona' OR "auth_method" = 'api_key'
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_metadata_safe_check_v2" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND ("metadata" - 'email' - 'planType' - 'snapshotName') = '{}'::jsonb
    AND ("provider" = 'daytona' OR NOT ("metadata" ? 'snapshotName'))
    AND ("provider" <> 'daytona' OR NOT ("metadata" ? 'email') AND NOT ("metadata" ? 'planType'))
    AND (NOT ("metadata" ? 'email') OR jsonb_typeof("metadata"->'email') = 'string')
    AND (NOT ("metadata" ? 'planType') OR jsonb_typeof("metadata"->'planType') = 'string')
    AND (NOT ("metadata" ? 'snapshotName') OR (
      jsonb_typeof("metadata"->'snapshotName') = 'string'
      AND length("metadata"->>'snapshotName') BETWEEN 1 AND 200
      AND ("metadata"->>'snapshotName') ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    ))
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  DROP CONSTRAINT "provider_connections_metadata_safe_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  RENAME CONSTRAINT "provider_connections_metadata_safe_check_v2"
  TO "provider_connections_metadata_safe_check";
