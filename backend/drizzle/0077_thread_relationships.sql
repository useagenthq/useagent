-- fast-deploy: expansion-safe
CREATE TABLE "thread_relationships" (
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_thread_id" text,
	"family_thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source_run_id" text NOT NULL,
	"source_execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_relationships_org_thread_pk" PRIMARY KEY("org_id", "thread_id"),
	CONSTRAINT "thread_relationships_kind_check" CHECK ("kind" IN ('root', 'delegated', 'continued_from_native')),
	CONSTRAINT "thread_relationships_title_check" CHECK (length("title") BETWEEN 1 AND 160),
	CONSTRAINT "thread_relationships_shape_check" CHECK (
		("kind" = 'root' AND "parent_thread_id" IS NULL AND "family_thread_id" = "thread_id" AND "source_run_id" = "thread_id" AND "source_execution_id" IS NULL)
		OR ("kind" = 'delegated' AND "parent_thread_id" IS NOT NULL AND "family_thread_id" <> "thread_id" AND "source_execution_id" IS NULL)
		OR ("kind" = 'continued_from_native' AND "parent_thread_id" IS NOT NULL AND "family_thread_id" <> "thread_id" AND "source_execution_id" IS NOT NULL)
	),
	CONSTRAINT "fk_thread_relationships_root_run" FOREIGN KEY ("org_id", "thread_id") REFERENCES "runs"("org_id", "id") ON DELETE cascade,
	CONSTRAINT "fk_thread_relationships_source_run" FOREIGN KEY ("org_id", "source_run_id") REFERENCES "runs"("org_id", "id") ON DELETE restrict,
	CONSTRAINT "fk_thread_relationships_source_execution" FOREIGN KEY ("org_id", "source_run_id", "source_execution_id") REFERENCES "agent_executions"("org_id", "run_id", "id") ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE "thread_relationships" ADD CONSTRAINT "fk_thread_relationships_parent" FOREIGN KEY ("org_id", "parent_thread_id") REFERENCES "thread_relationships"("org_id", "thread_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "thread_relationships" ADD CONSTRAINT "fk_thread_relationships_family" FOREIGN KEY ("org_id", "family_thread_id") REFERENCES "thread_relationships"("org_id", "thread_id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "idx_thread_relationships_family" ON "thread_relationships" ("org_id", "family_thread_id", "created_at", "thread_id");
--> statement-breakpoint
CREATE INDEX "idx_thread_relationships_parent" ON "thread_relationships" ("org_id", "parent_thread_id", "created_at", "thread_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_thread_relationship() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	anchor "runs"%ROWTYPE;
	parent_row "thread_relationships"%ROWTYPE;
	source_row "runs"%ROWTYPE;
	source_execution "agent_executions"%ROWTYPE;
BEGIN
	SELECT * INTO anchor FROM "runs" WHERE "org_id" = NEW."org_id" AND "id" = NEW."thread_id";
	IF NOT FOUND OR anchor."thread_id" <> anchor."id" OR anchor."parent_run_id" IS NOT NULL THEN
		RAISE EXCEPTION 'thread relationship anchor must be a tenant-owned root run' USING ERRCODE = '23514';
	END IF;
	IF NEW."kind" = 'root' AND anchor."origin" IS NOT NULL THEN
		RAISE EXCEPTION 'internal run cannot anchor a public thread relationship' USING ERRCODE = '23514';
	END IF;
	SELECT * INTO source_row FROM "runs" WHERE "org_id" = NEW."org_id" AND "id" = NEW."source_run_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'thread relationship source run is unavailable' USING ERRCODE = '23514';
	END IF;
	IF NEW."kind" <> 'root' THEN
		SELECT * INTO parent_row FROM "thread_relationships" WHERE "org_id" = NEW."org_id" AND "thread_id" = NEW."parent_thread_id";
		IF NOT FOUND OR parent_row."family_thread_id" <> NEW."family_thread_id" THEN
			RAISE EXCEPTION 'thread relationship parent and family mismatch' USING ERRCODE = '23514';
		END IF;
		IF source_row."thread_id" <> NEW."parent_thread_id" AND NOT EXISTS (
			SELECT 1 FROM "thread_relationships" source_relationship
			WHERE source_relationship."org_id" = NEW."org_id"
			  AND source_relationship."thread_id" = source_row."thread_id"
			  AND source_relationship."family_thread_id" = NEW."family_thread_id"
		) THEN
			RAISE EXCEPTION 'thread relationship source run is outside the authorized family' USING ERRCODE = '23514';
		END IF;
		IF NEW."kind" = 'continued_from_native' THEN
			SELECT * INTO source_execution FROM "agent_executions"
			WHERE "org_id" = NEW."org_id"
			  AND "run_id" = NEW."source_run_id"
			  AND "id" = NEW."source_execution_id";
			IF NOT FOUND OR source_execution."mode" <> 'native_child' THEN
				RAISE EXCEPTION 'continued relationship source must be a native child execution' USING ERRCODE = '23514';
			END IF;
		END IF;
		IF EXISTS (
			WITH RECURSIVE ancestors(thread_id) AS (
				SELECT NEW."parent_thread_id"
				UNION
				SELECT relationship."parent_thread_id"
				FROM "thread_relationships" relationship
				JOIN ancestors ON relationship."thread_id" = ancestors.thread_id
				WHERE relationship."org_id" = NEW."org_id"
				  AND relationship."parent_thread_id" IS NOT NULL
			)
			SELECT 1 FROM ancestors WHERE thread_id = NEW."thread_id"
		) THEN
			RAISE EXCEPTION 'thread relationship cycle' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_thread_relationship"
AFTER INSERT OR UPDATE ON "thread_relationships"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION validate_thread_relationship();
--> statement-breakpoint
INSERT INTO "thread_relationships" (
	"org_id", "thread_id", "parent_thread_id", "family_thread_id", "kind", "title", "source_run_id", "created_at", "updated_at"
)
SELECT
	"org_id", "id", NULL, "id", 'root',
	left(coalesce(nullif(btrim("prompt"), ''), 'Untitled thread'), 160),
	"id", "created_at", "updated_at"
FROM "runs"
WHERE "org_id" IS NOT NULL
	AND "id" = "thread_id"
	AND "parent_run_id" IS NULL
	AND "origin" IS NULL
ON CONFLICT ("org_id", "thread_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "child_thread_batches" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
	"org_id" text NOT NULL,
	"parent_thread_id" text NOT NULL,
	"parent_run_id" text NOT NULL,
	"family_thread_id" text NOT NULL,
	"actor_id" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "child_thread_batches_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 240),
	CONSTRAINT "child_thread_batches_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "child_thread_batches_count_check" CHECK ("item_count" BETWEEN 1 AND 20),
	CONSTRAINT "fk_child_thread_batches_parent" FOREIGN KEY ("org_id", "parent_thread_id") REFERENCES "thread_relationships"("org_id", "thread_id") ON DELETE restrict,
	CONSTRAINT "fk_child_thread_batches_family" FOREIGN KEY ("org_id", "family_thread_id") REFERENCES "thread_relationships"("org_id", "thread_id") ON DELETE restrict,
	CONSTRAINT "fk_child_thread_batches_parent_run" FOREIGN KEY ("org_id", "parent_run_id") REFERENCES "runs"("org_id", "id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_child_thread_batches_replay" ON "child_thread_batches" ("org_id", "parent_thread_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_child_thread_batches_org_id" ON "child_thread_batches" ("org_id", "id");
--> statement-breakpoint
CREATE INDEX "idx_child_thread_batches_family" ON "child_thread_batches" ("org_id", "family_thread_id", "created_at", "id");
--> statement-breakpoint
CREATE TABLE "child_thread_batch_items" (
	"batch_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"child_thread_id" text NOT NULL,
	"child_run_id" text NOT NULL,
	CONSTRAINT "child_thread_batch_items_batch_ordinal_pk" PRIMARY KEY("batch_id", "ordinal"),
	CONSTRAINT "child_thread_batch_items_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 19),
	CONSTRAINT "child_thread_batch_items_root_check" CHECK ("child_run_id" = "child_thread_id"),
	CONSTRAINT "fk_child_thread_batch_items_batch" FOREIGN KEY ("org_id", "batch_id") REFERENCES "child_thread_batches"("org_id", "id") ON DELETE restrict,
	CONSTRAINT "fk_child_thread_batch_items_relationship" FOREIGN KEY ("org_id", "child_thread_id") REFERENCES "thread_relationships"("org_id", "thread_id") ON DELETE restrict,
	CONSTRAINT "fk_child_thread_batch_items_run" FOREIGN KEY ("org_id", "child_run_id") REFERENCES "runs"("org_id", "id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_child_thread_batch_items_child" ON "child_thread_batch_items" ("org_id", "child_thread_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_child_thread_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	parent_run "runs"%ROWTYPE;
	parent_relationship "thread_relationships"%ROWTYPE;
BEGIN
	SELECT * INTO parent_run FROM "runs" WHERE "org_id" = NEW."org_id" AND "id" = NEW."parent_run_id";
	IF NOT FOUND OR parent_run."thread_id" <> NEW."parent_thread_id" THEN
		RAISE EXCEPTION 'child batch parent run does not belong to parent thread' USING ERRCODE = '23514';
	END IF;
	SELECT * INTO parent_relationship FROM "thread_relationships"
	WHERE "org_id" = NEW."org_id" AND "thread_id" = NEW."parent_thread_id";
	IF NOT FOUND OR parent_relationship."family_thread_id" <> NEW."family_thread_id" THEN
		RAISE EXCEPTION 'child batch parent and family mismatch' USING ERRCODE = '23514';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "child_thread_batch_items" item
		JOIN "thread_relationships" relationship
		  ON relationship."org_id" = item."org_id" AND relationship."thread_id" = item."child_thread_id"
		JOIN "runs" child_run
		  ON child_run."org_id" = item."org_id" AND child_run."id" = item."child_run_id"
		WHERE item."org_id" = NEW."org_id" AND item."batch_id" = NEW."id"
		  AND (
			relationship."parent_thread_id" <> NEW."parent_thread_id"
			OR relationship."family_thread_id" <> NEW."family_thread_id"
			OR child_run."thread_id" <> item."child_thread_id"
		  )
	) THEN
		RAISE EXCEPTION 'child batch items are outside the batch ownership boundary' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_child_thread_batch"
AFTER INSERT OR UPDATE ON "child_thread_batches"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_child_thread_batch();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_child_thread_batch_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	batch "child_thread_batches"%ROWTYPE;
	child_relationship "thread_relationships"%ROWTYPE;
	child_run "runs"%ROWTYPE;
BEGIN
	IF TG_OP = 'UPDATE' AND (OLD."org_id", OLD."batch_id") <> (NEW."org_id", NEW."batch_id") THEN
		RAISE EXCEPTION 'child batch item ownership is immutable' USING ERRCODE = '23514';
	END IF;
	SELECT * INTO batch FROM "child_thread_batches"
	WHERE "org_id" = NEW."org_id" AND "id" = NEW."batch_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'child batch item batch is unavailable' USING ERRCODE = '23514';
	END IF;
	SELECT * INTO child_relationship FROM "thread_relationships"
	WHERE "org_id" = NEW."org_id" AND "thread_id" = NEW."child_thread_id";
	IF NOT FOUND
		OR child_relationship."parent_thread_id" <> batch."parent_thread_id"
		OR child_relationship."family_thread_id" <> batch."family_thread_id"
		OR child_relationship."kind" = 'root' THEN
		RAISE EXCEPTION 'child batch item relationship is outside the batch family' USING ERRCODE = '23514';
	END IF;
	SELECT * INTO child_run FROM "runs"
	WHERE "org_id" = NEW."org_id" AND "id" = NEW."child_run_id";
	IF NOT FOUND OR child_run."thread_id" <> NEW."child_thread_id" THEN
		RAISE EXCEPTION 'child batch item run does not own child thread' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_child_thread_batch_item"
AFTER INSERT OR UPDATE ON "child_thread_batch_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_child_thread_batch_item();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_child_thread_batch_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target_org text;
	target_batch uuid;
	expected_count integer;
	actual_count integer;
	minimum_ordinal integer;
	maximum_ordinal integer;
BEGIN
	IF TG_TABLE_NAME = 'child_thread_batches' THEN
		target_org := NEW."org_id";
		target_batch := NEW."id";
	ELSIF TG_OP = 'DELETE' THEN
		target_org := OLD."org_id";
		target_batch := OLD."batch_id";
	ELSE
		target_org := NEW."org_id";
		target_batch := NEW."batch_id";
	END IF;
	SELECT "item_count" INTO expected_count FROM "child_thread_batches"
	WHERE "org_id" = target_org AND "id" = target_batch;
	IF NOT FOUND THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	SELECT count(*)::integer, min("ordinal"), max("ordinal")
	INTO actual_count, minimum_ordinal, maximum_ordinal
	FROM "child_thread_batch_items"
	WHERE "org_id" = target_org AND "batch_id" = target_batch;
	IF actual_count <> expected_count
		OR minimum_ordinal <> 0
		OR maximum_ordinal <> expected_count - 1 THEN
		RAISE EXCEPTION 'child batch items must exactly match count with contiguous ordinals' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_child_thread_batch_membership_batch"
AFTER INSERT OR UPDATE ON "child_thread_batches"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_child_thread_batch_membership();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_child_thread_batch_membership_item"
AFTER INSERT OR UPDATE OR DELETE ON "child_thread_batch_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_child_thread_batch_membership();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_batched_child_relationship_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "child_thread_batch_items" item
		JOIN "child_thread_batches" batch
		  ON batch."org_id" = item."org_id" AND batch."id" = item."batch_id"
		WHERE item."org_id" = NEW."org_id"
		  AND item."child_thread_id" = NEW."thread_id"
		  AND (
			NEW."parent_thread_id" <> batch."parent_thread_id"
			OR NEW."family_thread_id" <> batch."family_thread_id"
			OR NEW."kind" = 'root'
		  )
	) THEN
		RAISE EXCEPTION 'batched child relationship ownership is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_batched_child_relationship_update"
AFTER UPDATE ON "thread_relationships"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_batched_child_relationship_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_batched_child_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."thread_id" IS DISTINCT FROM OLD."thread_id" AND EXISTS (
		SELECT 1 FROM "child_thread_batch_items" item
		WHERE item."org_id" = NEW."org_id" AND item."child_run_id" = NEW."id"
	) THEN
		RAISE EXCEPTION 'batched child run ownership is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_validate_batched_child_run_update"
AFTER UPDATE ON "runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_batched_child_run_update();
