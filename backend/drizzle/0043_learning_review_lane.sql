CREATE TABLE "knowledge_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"accepted_record_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_revision_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"skill_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sections" jsonb NOT NULL,
	"source_draft_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolved_skill_id" uuid,
	"resolved_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD CONSTRAINT "knowledge_drafts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_revision_proposals" ADD CONSTRAINT "skill_revision_proposals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_knowledge_drafts_run" ON "knowledge_drafts" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_knowledge_drafts_org_status" ON "knowledge_drafts" USING btree ("org_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "idx_skill_proposals_org_status" ON "skill_revision_proposals" USING btree ("org_id","status","created_at");
