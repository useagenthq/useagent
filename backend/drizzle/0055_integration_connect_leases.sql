ALTER TABLE "integration_connect_sessions" ADD COLUMN "processing_token" text;
--> statement-breakpoint
ALTER TABLE "integration_connect_sessions" ADD COLUMN "processing_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_integration_connect_sessions_processing" ON "integration_connect_sessions" USING btree ("processing_expires_at") WHERE "processing_token" IS NOT NULL;
