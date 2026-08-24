-- fast-deploy: expansion-safe
CREATE TABLE "run_admissions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"cpu_millicores" integer NOT NULL,
	"memory_mib" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"queue_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"worker_lease_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"node" text,
	"sandbox_id" text,
	"reserved_cpu_millicores" integer NOT NULL,
	"reserved_memory_mib" integer NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"gc_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_gc_attempt_at" timestamp with time zone,
	"gc_last_error" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expiry" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_admissions" ADD CONSTRAINT "run_admissions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_run_admissions_state_priority" ON "run_admissions" USING btree ("state","priority","queued_at");
--> statement-breakpoint
CREATE INDEX "idx_run_admissions_org_state" ON "run_admissions" USING btree ("org_id","state");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_leases_state_expiry" ON "sandbox_leases" USING btree ("state","lease_expiry");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_leases_state_gc_retry" ON "sandbox_leases" USING btree ("state","next_gc_attempt_at");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_leases_org_state" ON "sandbox_leases" USING btree ("org_id","state");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_leases_run" ON "sandbox_leases" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sandbox_leases_active_run" ON "sandbox_leases" USING btree ("run_id") WHERE "state" in ('active', 'reclaiming');
