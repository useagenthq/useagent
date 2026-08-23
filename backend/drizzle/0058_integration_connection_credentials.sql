CREATE TABLE "integration_connection_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_connection_id" text NOT NULL,
	"format" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection_credentials" ADD CONSTRAINT "integration_creds_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_integration_connection_credentials_identity" ON "integration_connection_credentials" USING btree ("org_id","provider","external_connection_id");
