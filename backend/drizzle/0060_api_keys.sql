-- fast-deploy: expansion-safe
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_org" ON "api_keys" USING btree ("org_id");
