-- Persist the typed, authorized resources accepted for each run. The empty
-- default preserves legacy callers and makes pre-existing rows serialize as [].
ALTER TABLE "runs"
ADD COLUMN IF NOT EXISTS "resolved_resources" jsonb DEFAULT '[]'::jsonb NOT NULL;
