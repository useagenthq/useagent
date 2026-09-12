-- fast-deploy: expansion-safe
-- Box joins Daytona as a bring-your-own computer provider. Same discipline as
-- 0073: new checks apply to new/changed rows immediately and stay NOT VALID so
-- the migration transaction never scans the table.
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_provider_check_v3"
  CHECK ("provider" IN ('openai', 'anthropic', 'openrouter', 'daytona', 'box')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  DROP CONSTRAINT "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  RENAME CONSTRAINT "provider_connections_provider_check_v3"
  TO "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_computer_auth_check" CHECK (
    "provider" NOT IN ('daytona', 'box') OR "auth_method" = 'api_key'
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  DROP CONSTRAINT "provider_connections_daytona_auth_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_metadata_safe_check_v3" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND ("metadata" - 'email' - 'planType' - 'snapshotName') = '{}'::jsonb
    AND ("provider" IN ('daytona', 'box') OR NOT ("metadata" ? 'snapshotName'))
    AND ("provider" NOT IN ('daytona', 'box') OR NOT ("metadata" ? 'email') AND NOT ("metadata" ? 'planType'))
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
  RENAME CONSTRAINT "provider_connections_metadata_safe_check_v3"
  TO "provider_connections_metadata_safe_check";
