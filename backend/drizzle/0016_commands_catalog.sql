CREATE TABLE "commands_catalog" (
	"snapshot" text PRIMARY KEY NOT NULL,
	"commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
