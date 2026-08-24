-- fast-deploy: expansion-safe
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"project_key" text,
	"title" text NOT NULL,
	"body" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"order_key" double precision DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"source_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_tasks_org" ON "tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_org_project" ON "tasks" USING btree ("org_id","project_key");
