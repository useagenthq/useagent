-- fast-deploy: expansion-safe
-- Quality verification is additive and opt-in. Existing artifacts intentionally
-- have no receipt and therefore remain unverified after this migration.
CREATE TABLE "artifact_quality_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"artifact_revision" integer NOT NULL,
	"subject_digest" text NOT NULL,
	"quality_profile" text NOT NULL,
	"export_format" text NOT NULL,
	"export_digest" text NOT NULL,
	"visual_digest" text NOT NULL,
	"inspector_version" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_artifact_quality_receipts_artifact_scope" FOREIGN KEY ("org_id", "artifact_id", "thread_id") REFERENCES "artifacts"("org_id", "id", "thread_id"),
	CONSTRAINT "artifact_quality_receipts_revision_check" CHECK ("artifact_revision" >= 0),
	CONSTRAINT "artifact_quality_receipts_digest_check" CHECK ("subject_digest" ~ '^[0-9a-f]{64}$' AND "export_digest" ~ '^[0-9a-f]{64}$' AND "visual_digest" ~ '^[0-9a-f]{64}$' AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_quality_receipts_profile_check" CHECK (length("quality_profile") BETWEEN 1 AND 128 AND "quality_profile" ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
	CONSTRAINT "artifact_quality_receipts_export_format_check" CHECK (length("export_format") BETWEEN 1 AND 64 AND "export_format" ~ '^[a-z0-9][a-z0-9._+-]{0,63}$'),
	CONSTRAINT "artifact_quality_receipts_inspector_version_check" CHECK (length("inspector_version") BETWEEN 1 AND 128 AND "inspector_version" ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_quality_receipts_org_idempotency" ON "artifact_quality_receipts" ("org_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_quality_receipts_current_subject_profile" ON "artifact_quality_receipts" ("org_id", "artifact_id", "thread_id", "artifact_revision", "subject_digest", "quality_profile");
--> statement-breakpoint
CREATE INDEX "idx_artifact_quality_receipts_artifact_created" ON "artifact_quality_receipts" ("org_id", "artifact_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "forbid_artifact_quality_receipt_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'artifact quality receipts are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "artifact_quality_receipts_immutable"
BEFORE UPDATE OR DELETE ON "artifact_quality_receipts"
FOR EACH ROW EXECUTE FUNCTION "forbid_artifact_quality_receipt_mutation"();
