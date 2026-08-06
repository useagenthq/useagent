ALTER TABLE "skills" ADD COLUMN "kind" text DEFAULT 'skill' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD COLUMN "kind" text DEFAULT 'skill' NOT NULL;
