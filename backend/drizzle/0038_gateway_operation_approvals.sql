CREATE TABLE "gateway_operation_approvals" (
	"nonce" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
	"tool_name" text NOT NULL,
	"arguments_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_gateway_operation_approvals_expiry"
	ON "gateway_operation_approvals" ("expires_at");
