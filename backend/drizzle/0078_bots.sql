-- fast-deploy: expansion-safe
-- A bot is a named preset (engine, model, skills, repos, memory scope, standing
-- rules) over one durable home thread. Everything else about a bot - status,
-- last outcome, pending approvals - derives from the runs in that thread.
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"engine" text DEFAULT 'opencode' NOT NULL,
	"model" text,
	"skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory_scope" text DEFAULT 'org' NOT NULL,
	"avatar_tone" text DEFAULT 'blue' NOT NULL,
	"avatar_icon" text DEFAULT 'robot' NOT NULL,
	"home_thread_id" text,
	"created_by" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_name_check" CHECK (length("name") BETWEEN 1 AND 60),
	CONSTRAINT "bots_title_check" CHECK (length("title") <= 80),
	CONSTRAINT "bots_rules_check" CHECK (length("rules") <= 4000),
	CONSTRAINT "bots_memory_scope_check" CHECK ("memory_scope" IN ('org', 'personal')),
	CONSTRAINT "fk_bots_home_thread" FOREIGN KEY ("org_id", "home_thread_id") REFERENCES "runs"("org_id", "id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bots_org_name" ON "bots" ("org_id", "name");
--> statement-breakpoint
CREATE INDEX "idx_bots_org_active" ON "bots" ("org_id", "archived", "updated_at");
