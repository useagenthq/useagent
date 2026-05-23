CREATE TABLE "artifact_workpiece_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"proposer_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"base_revision" integer NOT NULL,
	"state" jsonb NOT NULL,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_revision" integer
);
--> statement-breakpoint
ALTER TABLE "artifact_workpiece_proposals" ADD CONSTRAINT "artifact_workpiece_proposals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_workpiece_proposals" ADD CONSTRAINT "artifact_workpiece_proposals_proposer_run_id_runs_id_fk" FOREIGN KEY ("proposer_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_artifact_proposals_artifact_status" ON "artifact_workpiece_proposals" USING btree ("artifact_id","status");
--> statement-breakpoint
CREATE INDEX "idx_artifact_proposals_org_created" ON "artifact_workpiece_proposals" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_artifact_proposals_run" ON "artifact_workpiece_proposals" USING btree ("proposer_run_id");
