CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"repo_full_name" text,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_projects_org_key" ON "projects" USING btree ("org_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_projects_org_repo" ON "projects" USING btree ("org_id","repo_full_name");
--> statement-breakpoint
CREATE INDEX "idx_projects_org_active_order" ON "projects" USING btree ("org_id","archived","sort_order","id");
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
INSERT INTO "projects" ("org_id", "key", "display_name", "repo_full_name")
SELECT DISTINCT "org_id", "repo", regexp_replace("repo", '^.*/', ''), "repo"
FROM "runs"
WHERE "org_id" IS NOT NULL AND "repo" IS NOT NULL AND btrim("repo") <> ''
ON CONFLICT ("org_id", "key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "projects" ("org_id", "key", "display_name")
SELECT DISTINCT "org_id", "project_key", regexp_replace("project_key", '^.*/', '')
FROM "tasks"
WHERE "project_key" IS NOT NULL AND btrim("project_key") <> ''
ON CONFLICT ("org_id", "key") DO NOTHING;
--> statement-breakpoint
UPDATE "runs" AS r
SET "project_id" = p."id"
FROM "projects" AS p
WHERE r."org_id" = p."org_id" AND r."repo" = p."key";
--> statement-breakpoint
UPDATE "tasks" AS t
SET "project_id" = p."id"
FROM "projects" AS p
WHERE t."org_id" = p."org_id" AND t."project_key" = p."key";
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_runs_org_project_created" ON "runs" USING btree ("org_id","project_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_org_project_id" ON "tasks" USING btree ("org_id","project_id");
