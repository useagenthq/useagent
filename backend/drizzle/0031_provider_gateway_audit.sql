CREATE TABLE "provider_gateway_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "runs"("id"),
  "org_id" text NOT NULL,
  "provider" text NOT NULL,
  "path" text NOT NULL,
  "model" text NOT NULL,
  "outcome" text NOT NULL,
  "upstream_status" integer,
  "duration_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
CREATE INDEX "idx_provider_gateway_audit_run" ON "provider_gateway_audit" ("run_id", "created_at");
