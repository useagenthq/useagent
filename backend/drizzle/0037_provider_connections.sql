CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"auth_method" text NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_provider_check" CHECK ("provider" IN ('openai', 'anthropic', 'openrouter')),
	CONSTRAINT "provider_connections_auth_method_check" CHECK ("auth_method" IN ('chatgpt_oauth', 'api_key')),
	CONSTRAINT "provider_connections_status_check" CHECK ("status" IN ('connected', 'reauth_required', 'revoked')),
	CONSTRAINT "provider_connections_metadata_safe_check" CHECK (
		jsonb_typeof("metadata") = 'object'
		AND ("metadata" - 'email' - 'planType') = '{}'::jsonb
		AND (NOT ("metadata" ? 'email') OR jsonb_typeof("metadata"->'email') = 'string')
		AND (NOT ("metadata" ? 'planType') OR jsonb_typeof("metadata"->'planType') = 'string')
	)
);
--> statement-breakpoint
CREATE INDEX "idx_provider_connections_org_user" ON "provider_connections" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_connections_scope" ON "provider_connections" USING btree ("org_id","user_id","provider","auth_method");
