CREATE TABLE "github_change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"project_id" uuid,
	"repo_full_name" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_size_bytes" integer NOT NULL,
	"payload_storage_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload_size_bytes" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text DEFAULT 'frozen' NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_change_sets_state_check" CHECK ("github_change_sets"."state" IN ('frozen', 'publishing', 'reconcile_required', 'published')),
	CONSTRAINT "github_change_sets_fingerprint_check" CHECK ("github_change_sets"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_change_sets_payload_sha_check" CHECK ("github_change_sets"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_change_sets_base_sha_check" CHECK ("github_change_sets"."base_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "github_change_sets_manifest_bounds_check" CHECK (jsonb_typeof("github_change_sets"."manifest") = 'object' AND jsonb_typeof("github_change_sets"."manifest"->'files') = 'array' AND jsonb_array_length("github_change_sets"."manifest"->'files') BETWEEN 1 AND 200 AND "github_change_sets"."manifest_size_bytes" BETWEEN 2 AND 65536 AND octet_length("github_change_sets"."manifest"::text) <= 65536),
	CONSTRAINT "github_change_sets_payload_size_check" CHECK ("github_change_sets"."payload_size_bytes" BETWEEN 0 AND 26214400)
);
--> statement-breakpoint
CREATE TABLE "github_publication_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"change_set_id" uuid NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target_branch" text NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"commit_message" text NOT NULL,
	"pull_request_title" text NOT NULL,
	"pull_request_body" text NOT NULL,
	"head_branch" text NOT NULL,
	"commit_sha" text,
	"pull_request_number" integer,
	"pull_request_url" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_publication_receipts_state_check" CHECK ("github_publication_receipts"."state" IN ('pending', 'publishing', 'reconcile_required', 'published', 'failed')),
	CONSTRAINT "github_publication_receipts_idempotency_hash_check" CHECK ("github_publication_receipts"."idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_publication_receipts_request_fingerprint_check" CHECK ("github_publication_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_publication_receipts_attempt_count_check" CHECK ("github_publication_receipts"."attempt_count" BETWEEN 0 AND 100),
	CONSTRAINT "github_publication_receipts_claim_check" CHECK (("github_publication_receipts"."claim_token" IS NULL AND "github_publication_receipts"."claim_expires_at" IS NULL) OR ("github_publication_receipts"."claim_token" IS NOT NULL AND "github_publication_receipts"."claim_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "github_change_sets" ADD CONSTRAINT "github_change_sets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "github_change_sets" ADD CONSTRAINT "github_change_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "github_publication_receipts" ADD CONSTRAINT "github_publication_receipts_change_set_id_github_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."github_change_sets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_change_sets_org_fingerprint" ON "github_change_sets" USING btree ("org_id","fingerprint");
--> statement-breakpoint
CREATE INDEX "idx_github_change_sets_org_run_created" ON "github_change_sets" USING btree ("org_id","run_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_github_change_sets_org_thread_created" ON "github_change_sets" USING btree ("org_id","thread_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_github_change_sets_org_repo_created" ON "github_change_sets" USING btree ("org_id","repo_full_name","created_at");
--> statement-breakpoint
CREATE INDEX "idx_github_change_sets_org_expiry" ON "github_change_sets" USING btree ("org_id","state","expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_publication_receipts_org_idempotency" ON "github_publication_receipts" USING btree ("org_id","idempotency_key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_publication_receipts_org_change_set" ON "github_publication_receipts" USING btree ("org_id","change_set_id");
--> statement-breakpoint
CREATE INDEX "idx_github_publication_receipts_change_set_state" ON "github_publication_receipts" USING btree ("change_set_id","state");
--> statement-breakpoint
CREATE INDEX "idx_github_publication_receipts_claim_expiry" ON "github_publication_receipts" USING btree ("state","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "idx_github_publication_receipts_org_created" ON "github_publication_receipts" USING btree ("org_id","created_at");
