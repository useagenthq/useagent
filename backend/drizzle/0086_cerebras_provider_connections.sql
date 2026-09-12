-- fast-deploy: expansion-safe
-- Cerebras is a model provider and uses the existing encrypted API-key path.
-- Keep the replacement check NOT VALID so new rows are enforced immediately
-- without scanning the existing provider-connection table during deployment.
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_provider_check_v4"
  CHECK ("provider" IN ('openai', 'anthropic', 'openrouter', 'cerebras', 'daytona', 'box')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections"
  DROP CONSTRAINT "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections"
  RENAME CONSTRAINT "provider_connections_provider_check_v4"
  TO "provider_connections_provider_check";
