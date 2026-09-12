-- fast-deploy: expansion-safe
-- A handoff is a child thread opened for a bot by an @mention (from a person
-- or from another bot). The thread itself is an ordinary delegated product
-- child; this row is what makes it the bot's work in the roster.
CREATE TABLE "bot_handoffs" (
	"org_id" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"parent_thread_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_handoffs_org_thread_pk" PRIMARY KEY("org_id", "thread_id"),
	CONSTRAINT "fk_bot_handoffs_bot" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade,
	CONSTRAINT "fk_bot_handoffs_thread" FOREIGN KEY ("org_id", "thread_id") REFERENCES "runs"("org_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "idx_bot_handoffs_bot" ON "bot_handoffs" ("org_id", "bot_id", "created_at");
