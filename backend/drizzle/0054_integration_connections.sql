CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_user_id" text,
	"provider" text NOT NULL,
	"runtime_binding_id" text NOT NULL,
	"external_connection_id" text NOT NULL,
	"external_connection_name" text,
	"status" text NOT NULL,
	"auth_method" text NOT NULL,
	"account_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_owner_type_check" CHECK ("owner_type" IN ('org', 'user')),
	CONSTRAINT "integration_connections_owner_check" CHECK (
		("owner_type" = 'org' AND "owner_user_id" IS NULL)
		OR ("owner_type" = 'user' AND "owner_user_id" IS NOT NULL)
	),
	CONSTRAINT "integration_connections_status_check" CHECK ("status" IN ('connecting', 'connected', 'reauth_required', 'unhealthy', 'revoked')),
	CONSTRAINT "integration_connections_auth_method_check" CHECK ("auth_method" IN ('oauth2', 'api_key', 'custom_credential')),
	CONSTRAINT "integration_connections_account_metadata_safe_check" CHECK (
		jsonb_typeof("account_metadata") = 'object'
		AND ("account_metadata" - 'externalAccountId' - 'displayName' - 'email' - 'avatarUrl') = '{}'::jsonb
		AND (NOT ("account_metadata" ? 'externalAccountId') OR jsonb_typeof("account_metadata"->'externalAccountId') = 'string')
		AND (NOT ("account_metadata" ? 'displayName') OR jsonb_typeof("account_metadata"->'displayName') = 'string')
		AND (NOT ("account_metadata" ? 'email') OR jsonb_typeof("account_metadata"->'email') = 'string')
		AND (NOT ("account_metadata" ? 'avatarUrl') OR jsonb_typeof("account_metadata"->'avatarUrl') = 'string')
	),
	CONSTRAINT "integration_connections_scopes_array_check" CHECK (jsonb_typeof("scopes") = 'array')
);
--> statement-breakpoint
CREATE INDEX "idx_integration_connections_org_owner" ON "integration_connections" USING btree ("org_id","owner_type","owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_connections_external_scope" ON "integration_connections" USING btree ("org_id","runtime_binding_id","provider","external_connection_id");
--> statement-breakpoint
CREATE TABLE "integration_connect_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_user_id" text,
	"provider" text NOT NULL,
	"runtime_binding_id" text NOT NULL,
	"backend_session_ref" text NOT NULL,
	"state_hash" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connect_sessions_owner_type_check" CHECK ("owner_type" IN ('org', 'user')),
	CONSTRAINT "integration_connect_sessions_owner_check" CHECK (
		("owner_type" = 'org' AND "owner_user_id" IS NULL)
		OR ("owner_type" = 'user' AND "owner_user_id" IS NOT NULL)
	),
	CONSTRAINT "integration_connect_sessions_state_hash_check" CHECK ("state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "integration_connect_sessions_return_to_check" CHECK (
		left("return_to", 1) = '/'
		AND left("return_to", 2) <> '//'
		AND position(E'\\' in "return_to") = 0
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_connect_sessions_state_hash" ON "integration_connect_sessions" USING btree ("state_hash");
--> statement-breakpoint
CREATE INDEX "idx_integration_connect_sessions_actor" ON "integration_connect_sessions" USING btree ("org_id","actor_user_id","expires_at");
