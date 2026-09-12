-- fast-deploy: expansion-safe
-- Record which provider (and whose credential) created a run's sandbox, so
-- later touches of that sandbox talk to the same provider.
ALTER TABLE "runs" ADD COLUMN "sandbox_provider" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_credential" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_sandbox_credential_check"
  CHECK ("sandbox_credential" IS NULL OR "sandbox_credential" IN ('env', 'user')) NOT VALID;
