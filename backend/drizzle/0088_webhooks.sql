CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text,
	"secret_iv" text,
	"secret_tag" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_endpoints_org" ON "webhook_endpoints" ("org_id", "disabled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_delivery_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
	"run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
	"event" text NOT NULL,
	"payload" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_webhook_delivery_endpoint_run" ON "webhook_delivery_outbox" ("endpoint_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_due" ON "webhook_delivery_outbox" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_delivery_org" ON "webhook_delivery_outbox" ("org_id", "created_at");
