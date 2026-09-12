-- fast-deploy: expansion-safe
-- Control-plane labels for sandboxes on providers without a label API (Box).
CREATE TABLE "sandbox_labels" (
	"provider" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_labels_pk" PRIMARY KEY("provider", "sandbox_id")
);
