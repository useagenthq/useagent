ALTER TABLE "schedules" ADD COLUMN "skill_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "skill_version" integer;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "skill_content_hash" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "repos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "delivery" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "notifications" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "run_actor_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "concurrency" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "queue" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "cost_limits" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "frequency_limits" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "approval_policy" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "enablement_policy" jsonb;
