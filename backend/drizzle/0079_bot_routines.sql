-- fast-deploy: expansion-safe
-- A routine is a schedule owned by a bot: it fires into the bot's home thread
-- instead of opening a fresh root, so the bot's DM carries its scheduled work.
ALTER TABLE "schedules" ADD COLUMN "bot_id" uuid;
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "fk_schedules_bot" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "idx_schedules_bot" ON "schedules" ("org_id", "bot_id");
