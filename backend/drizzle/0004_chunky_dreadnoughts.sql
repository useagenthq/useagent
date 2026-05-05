CREATE TABLE "schedule_firings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"prompt" text NOT NULL,
	"engine" text DEFAULT 'mock' NOT NULL,
	"model" text DEFAULT 'claude-sonnet-4-5' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_firings" ADD CONSTRAINT "schedule_firings_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_firings" ADD CONSTRAINT "schedule_firings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_firings_schedule" ON "schedule_firings" USING btree ("schedule_id","fired_at");--> statement-breakpoint
CREATE INDEX "idx_schedules_org" ON "schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_enabled" ON "schedules" USING btree ("enabled");