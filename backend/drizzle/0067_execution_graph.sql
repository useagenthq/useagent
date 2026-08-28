-- fast-deploy: expansion-safe
-- The migration only creates new tables/indexes. Existing runs.parent_run_id
-- semantics and the populated runs table remain untouched.
CREATE TABLE "agent_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source_key" text NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"native_session_id" text,
	"native_parent_session_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"last_event_id" text,
	"last_event_revision" bigint DEFAULT 0 NOT NULL,
	"last_delivery_seq" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_executions_mode_check" CHECK ("mode" IN ('root', 'native_child')),
	CONSTRAINT "agent_executions_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_executions_attempt_check" CHECK ("attempt" >= 1),
	CONSTRAINT "agent_executions_watermark_check" CHECK ("last_event_revision" >= 0 AND "last_delivery_seq" >= 0),
	CONSTRAINT "agent_executions_source_key_check" CHECK (length("source_key") > 0),
	CONSTRAINT "agent_executions_native_child_session_check" CHECK ("mode" <> 'native_child' OR "native_session_id" IS NOT NULL),
	CONSTRAINT "agent_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_executions_scope_id" ON "agent_executions" ("org_id", "run_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_executions_source" ON "agent_executions" ("org_id", "run_id", "source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_executions_root" ON "agent_executions" ("org_id", "run_id") WHERE "mode" = 'root';
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_executions_native_session" ON "agent_executions" ("org_id", "run_id", "provider", "native_session_id") WHERE "native_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_agent_executions_graph" ON "agent_executions" ("org_id", "run_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "idx_agent_executions_native_session" ON "agent_executions" ("provider", "native_session_id");
--> statement-breakpoint
CREATE TABLE "delegation_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source_key" text NOT NULL,
	"parent_execution_id" uuid NOT NULL,
	"child_execution_id" uuid,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_call_id" text,
	"native_event_id" text,
	"native_target_session_id" text,
	"observed_delivery_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegation_edges_kind_check" CHECK ("kind" IN ('spawn', 'wait', 'send', 'resume', 'close', 'gather')),
	CONSTRAINT "delegation_edges_spawn_child_check" CHECK ("kind" <> 'spawn' OR "child_execution_id" IS NOT NULL),
	CONSTRAINT "delegation_edges_source_key_check" CHECK (length("source_key") > 0),
	CONSTRAINT "delegation_edges_provider_identity_check" CHECK (("provider_call_id" IS NOT NULL AND length("provider_call_id") > 0) OR ("native_event_id" IS NOT NULL AND length("native_event_id") > 0)),
	CONSTRAINT "delegation_edges_delivery_seq_check" CHECK ("observed_delivery_seq" >= 0),
	CONSTRAINT "delegation_edges_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade,
	CONSTRAINT "fk_delegation_edges_parent_execution" FOREIGN KEY ("org_id", "run_id", "parent_execution_id") REFERENCES "agent_executions"("org_id", "run_id", "id") ON DELETE cascade,
	CONSTRAINT "fk_delegation_edges_child_execution" FOREIGN KEY ("org_id", "run_id", "child_execution_id") REFERENCES "agent_executions"("org_id", "run_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_delegation_edges_source" ON "delegation_edges" ("org_id", "run_id", "source_key");
--> statement-breakpoint
CREATE INDEX "idx_delegation_edges_graph" ON "delegation_edges" ("org_id", "run_id", "observed_delivery_seq", "id");
--> statement-breakpoint
CREATE INDEX "idx_delegation_edges_parent" ON "delegation_edges" ("org_id", "run_id", "parent_execution_id", "observed_delivery_seq", "id");
--> statement-breakpoint
CREATE INDEX "idx_delegation_edges_child" ON "delegation_edges" ("org_id", "run_id", "child_execution_id", "observed_delivery_seq", "id");
