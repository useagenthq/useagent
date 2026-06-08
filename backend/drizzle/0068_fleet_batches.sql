-- fast-deploy: expansion-safe
CREATE TABLE "fleet_batches" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_batches_org_id_id_pk" PRIMARY KEY("org_id", "id"),
	CONSTRAINT "fleet_batches_idempotency_hash_check" CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fleet_batches_request_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fleet_batches_item_count_check" CHECK ("item_count" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fleet_batches_org_idempotency" ON "fleet_batches" ("org_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE INDEX "idx_fleet_batches_org_created" ON "fleet_batches" ("org_id", "created_at", "id");
--> statement-breakpoint
CREATE TABLE "fleet_batch_runs" (
	"org_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_batch_runs_org_batch_ordinal_pk" PRIMARY KEY("org_id", "batch_id", "ordinal"),
	CONSTRAINT "fleet_batch_runs_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 19),
	CONSTRAINT "fk_fleet_batch_runs_batch" FOREIGN KEY ("org_id", "batch_id") REFERENCES "fleet_batches"("org_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fleet_batch_runs_org_run" ON "fleet_batch_runs" ("org_id", "run_id");
--> statement-breakpoint
CREATE INDEX "idx_fleet_batch_runs_org_batch" ON "fleet_batch_runs" ("org_id", "batch_id", "ordinal");
