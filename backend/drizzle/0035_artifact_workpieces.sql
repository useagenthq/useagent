ALTER TABLE "artifacts" ADD COLUMN "workpiece_kind" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "workpiece_state" jsonb;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "workpiece_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "artifacts"
SET "workpiece_kind" = CASE
  WHEN lower(split_part("content_type", ';', 1)) = 'text/csv' OR lower("name") LIKE '%.csv' THEN 'spreadsheet'
  WHEN lower(split_part("content_type", ';', 1)) IN (
      'application/json',
      'application/xml',
      'text/markdown',
      'text/plain',
      'text/tab-separated-values',
      'text/x-markdown'
    )
    OR lower("name") ~ '\\.(md|markdown|json|txt|xml|yaml|yml)$' THEN 'document'
  ELSE NULL
END;
