CREATE TABLE "gateway_approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
	"thread_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"arguments_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"capability" text,
	"capability_expires_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE INDEX "idx_gateway_approval_requests_run"
	ON "gateway_approval_requests" ("run_id", "status");
--> statement-breakpoint
CREATE INDEX "idx_gateway_approval_requests_thread"
	ON "gateway_approval_requests" ("thread_id", "status");
