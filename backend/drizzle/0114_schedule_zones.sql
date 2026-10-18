-- fast-deploy: expansion-safe
-- Every schedule names the zone its cron runs in. One saved without a zone ran
-- on its backend's own clock. The backend migrates at boot, and the release
-- script runs under the backend's env, so the pool applying this names that
-- clock's zone in useagent.backend_time_zone (src/db/client.ts): the clock
-- such a schedule would read after the swap anyway. Each gets that zone here
-- and keeps firing at the times it did. Applied without the setting (a scratch
-- database, a tool), this refuses any schedule that needs a zone rather than
-- guess one.
--
-- The previous backend serves until the swap and still saves a schedule sent
-- without a zone, or one cleared, with none. The trigger gives that write the
-- same zone, so the column can be NOT NULL now.
--
-- The table lock comes first and is the strongest this needs (SET NOT NULL's):
-- holding nothing while it waits, the migration never deadlocks with a writer
-- that locked a row and has its UPDATE still to run, and once held no write
-- slips in between the backfill and the constraint.
LOCK TABLE "schedules" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  zone text := nullif(current_setting('useagent.backend_time_zone', true), '');
BEGIN
  IF zone IS NULL AND EXISTS (SELECT 1 FROM "schedules" WHERE "timezone" IS NULL) THEN
    RAISE EXCEPTION 'schedules saved without a zone ran on the backend''s clock: apply migrations through the backend, which names that zone in useagent.backend_time_zone';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION "schedules_timezone_fill"() RETURNS trigger LANGUAGE plpgsql AS %L',
    format('BEGIN NEW."timezone" := %L; RETURN NEW; END', zone)
  );
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "schedules_timezone_fill" ON "schedules";
--> statement-breakpoint
CREATE TRIGGER "schedules_timezone_fill" BEFORE INSERT OR UPDATE OF "timezone" ON "schedules"
  FOR EACH ROW WHEN (NEW."timezone" IS NULL) EXECUTE FUNCTION "schedules_timezone_fill"();
--> statement-breakpoint
UPDATE "schedules" SET "timezone" = current_setting('useagent.backend_time_zone', true) WHERE "timezone" IS NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "timezone" SET NOT NULL;
