CREATE TABLE "slack_users" (
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_users_team_id_slack_user_id_pk" PRIMARY KEY("team_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "slack_users" ADD CONSTRAINT "slack_users_team_id_slack_workspaces_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."slack_workspaces"("team_id") ON DELETE cascade ON UPDATE no action;
