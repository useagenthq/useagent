-- fast-deploy: expansion-safe
-- Terminal Slack rows double as a durable receipt outbox. Existing rows remain
-- NULL and are replayed idempotently by the delivery relay after deployment.
ALTER TABLE "slack_outbox" ADD COLUMN "receipt_emitted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_slack_outbox_receipt_pending"
ON "slack_outbox" ("updated_at", "id")
WHERE "receipt_emitted_at" IS NULL
  AND ("state" = 'dead' OR ("state" = 'delivered' AND "kind" = 'upload_file'));
