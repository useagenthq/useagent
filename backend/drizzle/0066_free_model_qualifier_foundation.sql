-- fast-deploy: expansion-safe
CREATE TABLE "free_model_candidates" (
	"model_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"advertised" boolean DEFAULT false NOT NULL,
	"ever_qualified" boolean DEFAULT false NOT NULL,
	"success_streak" integer DEFAULT 0 NOT NULL,
	"failure_streak" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_probe_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"last_claimed_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_model_candidates_state_check" CHECK ("state" IN ('pending', 'qualified', 'disqualified', 'disabled')),
	CONSTRAINT "free_model_candidates_outcome_check" CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('success', 'failure', 'system_failure')),
	CONSTRAINT "free_model_candidates_counter_check" CHECK ("success_streak" BETWEEN 0 AND 1000000 AND "failure_streak" BETWEEN 0 AND 1000000 AND "attempt_count" BETWEEN 0 AND 2147483647),
	CONSTRAINT "free_model_candidates_claim_check" CHECK (("claim_token" IS NULL AND "claim_expires_at" IS NULL) OR ("claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "free_model_probe_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"claim_token" uuid NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error_code" text,
	"probed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_model_probe_attempts_outcome_check" CHECK ("outcome" IN ('success', 'failure', 'system_failure')),
	CONSTRAINT "free_model_probe_attempts_http_status_check" CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
	CONSTRAINT "free_model_probe_attempts_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" BETWEEN 0 AND 3600000),
	CONSTRAINT "free_model_probe_attempts_error_code_check" CHECK ("error_code" IS NULL OR "error_code" IN ('authentication_failed', 'hosted_app_restricted', 'invalid_response', 'policy_rejected', 'provider_capacity', 'rate_limited', 'timeout', 'tool_call_failed', 'transport_error', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "free_model_registry_state" (
	"lane" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"current_model_ids" jsonb NOT NULL,
	"last_good_model_ids" jsonb NOT NULL,
	"last_publish_outcome" text DEFAULT 'published' NOT NULL,
	"last_publish_at" timestamp with time zone DEFAULT now() NOT NULL,
	"probe_budget_day" date NOT NULL,
	"daily_probe_budget" integer DEFAULT 24 NOT NULL,
	"probes_claimed_today" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_model_registry_state_publish_outcome_check" CHECK ("last_publish_outcome" IN ('published', 'preserved_empty', 'preserved_system_failure')),
	CONSTRAINT "free_model_registry_state_generation_check" CHECK ("generation" >= 1),
	CONSTRAINT "free_model_registry_state_model_ids_check" CHECK (jsonb_typeof("current_model_ids") = 'array' AND jsonb_typeof("last_good_model_ids") = 'array'),
	CONSTRAINT "free_model_registry_state_budget_check" CHECK ("daily_probe_budget" BETWEEN 1 AND 10000 AND "probes_claimed_today" BETWEEN 0 AND "daily_probe_budget")
);
--> statement-breakpoint
ALTER TABLE "free_model_probe_attempts" ADD CONSTRAINT "fk_free_model_probe_candidate" FOREIGN KEY ("model_id") REFERENCES "public"."free_model_candidates"("model_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_free_model_candidates_due" ON "free_model_candidates" USING btree ("next_probe_at", "model_id") WHERE "state" <> 'disabled';
--> statement-breakpoint
CREATE INDEX "idx_free_model_candidates_claim_expiry" ON "free_model_candidates" USING btree ("claim_expires_at");
--> statement-breakpoint
CREATE INDEX "idx_free_model_candidates_advertised" ON "free_model_candidates" USING btree ("advertised", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_free_model_probe_attempts_claim" ON "free_model_probe_attempts" USING btree ("model_id", "claim_token");
--> statement-breakpoint
CREATE INDEX "idx_free_model_probe_attempts_model_time" ON "free_model_probe_attempts" USING btree ("model_id", "probed_at");
--> statement-breakpoint
INSERT INTO "free_model_candidates" (
	"model_id", "provider", "source", "state", "advertised", "ever_qualified",
	"success_streak", "failure_streak", "attempt_count", "qualified_at"
) VALUES
	('minimax/minimax-m3:free', 'openrouter', 'bootstrap_v0_0_1', 'qualified', true, true, 2, 0, 0, now()),
	('dots-studio/dots-3-note-preview:free', 'openrouter', 'bootstrap_v0_0_1', 'qualified', true, true, 2, 0, 0, now()),
	('nvidia/nemotron-3-super-120b-a12b:free', 'openrouter', 'bootstrap_v0_0_1', 'qualified', true, true, 2, 0, 0, now())
ON CONFLICT ("model_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "free_model_registry_state" (
	"lane", "generation", "current_model_ids", "last_good_model_ids",
	"last_publish_outcome", "probe_budget_day", "daily_probe_budget", "probes_claimed_today"
) VALUES (
	'opencode_free',
	1,
	'["minimax/minimax-m3:free","dots-studio/dots-3-note-preview:free","nvidia/nemotron-3-super-120b-a12b:free"]'::jsonb,
	'["minimax/minimax-m3:free","dots-studio/dots-3-note-preview:free","nvidia/nemotron-3-super-120b-a12b:free"]'::jsonb,
	'published',
	(now() AT TIME ZONE 'UTC')::date,
	24,
	0
)
ON CONFLICT ("lane") DO NOTHING;
