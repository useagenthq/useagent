-- fast-deploy: requires-reconciliation
-- The finished-work tables are additive and dormant while FINISHED_WORK_ROLLOUT
-- is off. The Slack uniqueness contracts below reconcile valid pre-0072 data,
-- so this migration is intentionally not labelled expansion-safe.
CREATE UNIQUE INDEX "uq_runs_org_id" ON "runs" ("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_finished_work_scope" ON "runs" ("org_id", "id", "thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifacts_finished_work_scope" ON "artifacts" ("org_id", "id", "thread_id");
--> statement-breakpoint
CREATE TEMP TABLE "_0072_slack_thread_reconciliation" ON COMMIT DROP AS
WITH ranked AS (
	SELECT
		st."org_id",
		st."root_run_id",
		st."team_id",
		st."channel",
		st."thread_ts",
		first_value(st."team_id") OVER choice AS "canonical_team_id",
		first_value(st."channel") OVER choice AS "canonical_channel",
		first_value(st."thread_ts") OVER choice AS "canonical_thread_ts",
		row_number() OVER choice AS "choice_rank"
	FROM "slack_threads" st
	WINDOW choice AS (
		PARTITION BY st."org_id", st."root_run_id"
		ORDER BY
			EXISTS (
				SELECT 1 FROM "slack_run_responses" srr
				WHERE srr."run_id" = st."root_run_id"
				  AND srr."team_id" = st."team_id"
				  AND srr."channel" = st."channel"
				  AND srr."thread_ts" = st."thread_ts"
			) DESC,
			st."created_at" ASC,
			st."team_id" ASC,
			st."channel" ASC,
			st."thread_ts" ASC
	)
)
SELECT * FROM ranked;
--> statement-breakpoint
CREATE TEMP TABLE "_0072_slack_response_reconciliation" ON COMMIT DROP AS
WITH candidates AS (
	SELECT
		srr."run_id",
		srr."team_id",
		srr."channel",
		srr."thread_ts",
		canonical."canonical_team_id",
		canonical."canonical_channel",
		canonical."canonical_thread_ts",
		row_number() OVER (
			PARTITION BY srr."run_id"
			ORDER BY
				(
					srr."team_id" = canonical."canonical_team_id"
					AND srr."channel" = canonical."canonical_channel"
					AND srr."thread_ts" = canonical."canonical_thread_ts"
				) DESC NULLS LAST,
				srr."updated_at" DESC,
				srr."created_at" ASC,
				srr."team_id" ASC,
				srr."channel" ASC,
				srr."thread_ts" ASC
		) AS "choice_rank"
	FROM "slack_run_responses" srr
	JOIN "runs" r ON r."id" = srr."run_id"
	LEFT JOIN "_0072_slack_thread_reconciliation" canonical
		ON canonical."org_id" = r."org_id"
		AND canonical."root_run_id" = r."thread_id"
		AND canonical."choice_rank" = 1
)
SELECT * FROM candidates;
--> statement-breakpoint
DO $$
DECLARE
	thread_rows bigint;
	response_rows bigint;
BEGIN
	SELECT count(*) INTO thread_rows
	FROM "_0072_slack_thread_reconciliation"
	WHERE "choice_rank" > 1;
	SELECT count(*) INTO response_rows
	FROM "_0072_slack_response_reconciliation"
	WHERE "choice_rank" > 1;
	RAISE NOTICE '0072 Slack reconciliation audit: duplicate_threads=%, duplicate_run_responses=%',
		thread_rows, response_rows;
END;
$$;
--> statement-breakpoint
DELETE FROM "slack_run_responses" srr
USING "_0072_slack_response_reconciliation" reconciliation
WHERE reconciliation."run_id" = srr."run_id"
  AND reconciliation."team_id" = srr."team_id"
  AND reconciliation."channel" = srr."channel"
  AND reconciliation."thread_ts" = srr."thread_ts"
  AND reconciliation."choice_rank" > 1;
--> statement-breakpoint
UPDATE "slack_run_responses" srr
SET
	"team_id" = reconciliation."canonical_team_id",
	"channel" = reconciliation."canonical_channel",
	"thread_ts" = reconciliation."canonical_thread_ts",
	"updated_at" = now()
FROM "_0072_slack_response_reconciliation" reconciliation
WHERE reconciliation."run_id" = srr."run_id"
  AND reconciliation."team_id" = srr."team_id"
  AND reconciliation."channel" = srr."channel"
  AND reconciliation."thread_ts" = srr."thread_ts"
  AND reconciliation."choice_rank" = 1
  AND reconciliation."canonical_team_id" IS NOT NULL
  AND (
	  srr."team_id",
	  srr."channel",
	  srr."thread_ts"
  ) IS DISTINCT FROM (
	  reconciliation."canonical_team_id",
	  reconciliation."canonical_channel",
	  reconciliation."canonical_thread_ts"
  );
--> statement-breakpoint
DELETE FROM "slack_threads" st
USING "_0072_slack_thread_reconciliation" reconciliation
WHERE reconciliation."org_id" = st."org_id"
  AND reconciliation."root_run_id" = st."root_run_id"
  AND reconciliation."team_id" = st."team_id"
  AND reconciliation."channel" = st."channel"
  AND reconciliation."thread_ts" = st."thread_ts"
  AND reconciliation."choice_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_threads_org_root" ON "slack_threads" ("org_id", "root_run_id");
--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "fk_slack_threads_org_root" FOREIGN KEY ("org_id", "root_run_id") REFERENCES "runs"("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_run_responses_run" ON "slack_run_responses" ("run_id");
--> statement-breakpoint
CREATE TABLE "finished_work_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"authority" text NOT NULL,
	"source_key" text NOT NULL,
	"requirement" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"source_provider" text,
	"source_call_id" text,
	"candidate_name" text,
	"target_artifact_id" uuid,
	"materialized_artifact_id" uuid,
	"materialized_artifact_revision" integer,
	"failure_code" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_finished_work_obligations_run_scope" FOREIGN KEY ("org_id", "run_id", "thread_id") REFERENCES "runs"("org_id", "id", "thread_id") ON DELETE cascade,
	CONSTRAINT "fk_finished_work_obligations_target_artifact_scope" FOREIGN KEY ("org_id", "target_artifact_id", "thread_id") REFERENCES "artifacts"("org_id", "id", "thread_id"),
	CONSTRAINT "fk_finished_work_obligations_materialized_artifact_scope" FOREIGN KEY ("org_id", "materialized_artifact_id", "thread_id") REFERENCES "artifacts"("org_id", "id", "thread_id"),
	CONSTRAINT "finished_work_obligations_source_kind_check" CHECK ("source_kind" IN ('gateway_tool', 'provider_native', 'sandbox_output')),
	CONSTRAINT "finished_work_obligations_authority_check" CHECK (("source_kind" IN ('gateway_tool', 'sandbox_output') AND "authority" = 'integration_gateway') OR ("source_kind" = 'provider_native' AND "authority" = 'provider_adapter')),
	CONSTRAINT "finished_work_obligations_requirement_check" CHECK ("requirement" IN ('artifact_create', 'artifact_update', 'external_action')),
	CONSTRAINT "finished_work_obligations_state_check" CHECK ("state" IN ('open', 'satisfied', 'failed', 'waived')),
	CONSTRAINT "finished_work_obligations_source_key_check" CHECK (length("source_key") BETWEEN 1 AND 256 AND "source_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$'),
	CONSTRAINT "finished_work_obligations_source_provider_check" CHECK ("source_provider" IS NULL OR (length("source_provider") BETWEEN 1 AND 64 AND "source_provider" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')),
	CONSTRAINT "finished_work_obligations_source_call_check" CHECK ("source_call_id" IS NULL OR (length("source_call_id") BETWEEN 1 AND 256 AND "source_call_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$')),
	CONSTRAINT "finished_work_obligations_candidate_name_check" CHECK ("candidate_name" IS NULL OR (length("candidate_name") BETWEEN 1 AND 255 AND "candidate_name" !~ '[\/\\[:cntrl:]]' AND "candidate_name" !~* '^[a-z][a-z0-9+.-]*://')),
	CONSTRAINT "finished_work_obligations_failure_code_check" CHECK ("failure_code" IS NULL OR ("state" = 'failed' AND length("failure_code") BETWEEN 1 AND 64 AND "failure_code" ~ '^[a-z][a-z0-9_.-]{0,63}$')),
	CONSTRAINT "finished_work_obligations_resolution_check" CHECK (("resolved_at" IS NULL) = ("state" = 'open')),
	CONSTRAINT "finished_work_obligations_update_target_check" CHECK ("requirement" <> 'artifact_update' OR "target_artifact_id" IS NOT NULL),
	CONSTRAINT "finished_work_obligations_materialization_check" CHECK (("materialized_artifact_id" IS NULL AND "materialized_artifact_revision" IS NULL) OR ("materialized_artifact_id" IS NOT NULL AND "materialized_artifact_revision" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_finished_work_obligations_run_source" ON "finished_work_obligations" ("run_id", "source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_finished_work_obligations_scope_id" ON "finished_work_obligations" ("org_id", "run_id", "thread_id", "id");
--> statement-breakpoint
CREATE INDEX "idx_finished_work_obligations_run_state" ON "finished_work_obligations" ("run_id", "state", "opened_at", "id");
--> statement-breakpoint
CREATE TABLE "finished_work_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"obligation_id" uuid,
	"kind" text NOT NULL,
	"authority" text NOT NULL,
	"source_key" text NOT NULL,
	"artifact_id" uuid,
	"artifact_revision" integer,
	"external_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fk_finished_work_receipts_run_scope" FOREIGN KEY ("org_id", "run_id", "thread_id") REFERENCES "runs"("org_id", "id", "thread_id") ON DELETE cascade,
	CONSTRAINT "fk_finished_work_receipts_obligation_scope" FOREIGN KEY ("org_id", "run_id", "thread_id", "obligation_id") REFERENCES "finished_work_obligations"("org_id", "run_id", "thread_id", "id"),
	CONSTRAINT "fk_finished_work_receipts_artifact_scope" FOREIGN KEY ("org_id", "artifact_id", "thread_id") REFERENCES "artifacts"("org_id", "id", "thread_id"),
	CONSTRAINT "finished_work_receipts_kind_check" CHECK ("kind" IN ('artifact_created', 'artifact_updated', 'repository_changed', 'external_action_completed', 'read_only_answer')),
	CONSTRAINT "finished_work_receipts_authority_check" CHECK ("authority" IN ('artifact_store', 'workpiece_store', 'github_publication', 'slack_outbox', 'integration_gateway', 'run_engine') AND (("kind" IN ('artifact_created', 'artifact_updated') AND "authority" IN ('artifact_store', 'workpiece_store')) OR ("kind" = 'repository_changed' AND "authority" = 'github_publication') OR ("kind" = 'external_action_completed' AND "authority" IN ('github_publication', 'slack_outbox', 'integration_gateway')) OR ("kind" = 'read_only_answer' AND "authority" = 'run_engine'))),
	CONSTRAINT "finished_work_receipts_source_key_check" CHECK (length("source_key") BETWEEN 1 AND 256 AND "source_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$'),
	CONSTRAINT "finished_work_receipts_artifact_check" CHECK ("kind" NOT IN ('artifact_created', 'artifact_updated') OR "artifact_id" IS NOT NULL),
	CONSTRAINT "finished_work_receipts_artifact_revision_check" CHECK ("artifact_revision" IS NULL OR ("artifact_id" IS NOT NULL AND "artifact_revision" >= 0)),
	CONSTRAINT "finished_work_receipts_external_ref_check" CHECK ("external_ref" IS NULL OR (length("external_ref") BETWEEN 1 AND 256 AND "external_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$')),
	CONSTRAINT "finished_work_receipts_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 8192 AND ("metadata" - 'count' - 'itemCount' - 'byteCount' - 'digest' - 'mime' - 'provider' - 'action' - 'commitSha' - 'pullRequestUrl') = '{}'::jsonb AND (NOT ("metadata" ? 'count') OR (jsonb_typeof("metadata"->'count') = 'number' AND (("metadata"->>'count')::numeric % 1) = 0 AND ("metadata"->>'count')::numeric >= 0)) AND (NOT ("metadata" ? 'itemCount') OR (jsonb_typeof("metadata"->'itemCount') = 'number' AND (("metadata"->>'itemCount')::numeric % 1) = 0 AND ("metadata"->>'itemCount')::numeric >= 0)) AND (NOT ("metadata" ? 'byteCount') OR (jsonb_typeof("metadata"->'byteCount') = 'number' AND (("metadata"->>'byteCount')::numeric % 1) = 0 AND ("metadata"->>'byteCount')::numeric >= 0)) AND (NOT ("metadata" ? 'digest') OR (jsonb_typeof("metadata"->'digest') = 'string' AND "metadata"->>'digest' ~ '^[0-9A-Fa-f]{64}$')) AND (NOT ("metadata" ? 'mime') OR (jsonb_typeof("metadata"->'mime') = 'string' AND length("metadata"->>'mime') BETWEEN 3 AND 127 AND "metadata"->>'mime' ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$')) AND (NOT ("metadata" ? 'provider') OR (jsonb_typeof("metadata"->'provider') = 'string' AND length("metadata"->>'provider') BETWEEN 1 AND 64 AND "metadata"->>'provider' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')) AND (NOT ("metadata" ? 'action') OR (jsonb_typeof("metadata"->'action') = 'string' AND length("metadata"->>'action') BETWEEN 1 AND 64 AND "metadata"->>'action' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')) AND (NOT ("metadata" ? 'commitSha') OR (jsonb_typeof("metadata"->'commitSha') = 'string' AND "metadata"->>'commitSha' ~ '^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$')) AND (NOT ("metadata" ? 'pullRequestUrl') OR (jsonb_typeof("metadata"->'pullRequestUrl') = 'string' AND length("metadata"->>'pullRequestUrl') BETWEEN 1 AND 2048 AND "metadata"->>'pullRequestUrl' ~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$' AND split_part("metadata"->>'pullRequestUrl', '/', 4) NOT IN ('.', '..') AND split_part("metadata"->>'pullRequestUrl', '/', 5) NOT IN ('.', '..') AND "metadata"->>'pullRequestUrl' = 'https://github.com/' || split_part("metadata"->>'pullRequestUrl', '/', 4) || '/' || split_part("metadata"->>'pullRequestUrl', '/', 5) || '/pull/' || split_part("metadata"->>'pullRequestUrl', '/', 7))))
);
--> statement-breakpoint
CREATE FUNCTION "forbid_finished_work_obligation_semantic_update"() RETURNS trigger AS $$
BEGIN
	IF ROW(NEW."id", NEW."org_id", NEW."run_id", NEW."thread_id", NEW."source_kind", NEW."authority", NEW."source_key", NEW."requirement", NEW."source_provider", NEW."source_call_id", NEW."candidate_name", NEW."target_artifact_id")
		IS DISTINCT FROM ROW(OLD."id", OLD."org_id", OLD."run_id", OLD."thread_id", OLD."source_kind", OLD."authority", OLD."source_key", OLD."requirement", OLD."source_provider", OLD."source_call_id", OLD."candidate_name", OLD."target_artifact_id") THEN
		RAISE EXCEPTION 'finished work obligation semantics are immutable after open' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "finished_work_obligations_immutable"
BEFORE UPDATE ON "finished_work_obligations"
FOR EACH ROW EXECUTE FUNCTION "forbid_finished_work_obligation_semantic_update"();
--> statement-breakpoint
CREATE FUNCTION "forbid_finished_work_receipt_update"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'finished work receipts are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "finished_work_receipts_immutable"
BEFORE UPDATE ON "finished_work_receipts"
FOR EACH ROW EXECUTE FUNCTION "forbid_finished_work_receipt_update"();
--> statement-breakpoint
CREATE FUNCTION "validate_finished_work_receipt"() RETURNS trigger AS $$
DECLARE
	obligation_requirement text;
	obligation_target_artifact_id uuid;
	obligation_materialized_artifact_id uuid;
	obligation_materialized_artifact_revision integer;
	artifact_run_id text;
BEGIN
	IF NEW."kind" = 'artifact_created' THEN
		SELECT "run_id" INTO artifact_run_id FROM "artifacts" WHERE "id" = NEW."artifact_id";
		IF artifact_run_id IS DISTINCT FROM NEW."run_id" THEN
			RAISE EXCEPTION 'artifact_created receipt must reference an artifact created by the current run' USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."kind" = 'artifact_updated' AND NEW."obligation_id" IS NULL THEN
		RAISE EXCEPTION 'artifact_updated receipt requires an obligation' USING ERRCODE = '23514';
	END IF;

	IF NEW."obligation_id" IS NOT NULL THEN
		SELECT "requirement", "target_artifact_id", "materialized_artifact_id", "materialized_artifact_revision"
		INTO obligation_requirement, obligation_target_artifact_id, obligation_materialized_artifact_id, obligation_materialized_artifact_revision
		FROM "finished_work_obligations"
		WHERE "id" = NEW."obligation_id"
		  AND "org_id" = NEW."org_id"
		  AND "run_id" = NEW."run_id"
		  AND "thread_id" = NEW."thread_id";

		IF obligation_requirement IS NULL THEN
			RAISE EXCEPTION 'finished work obligation is outside receipt scope' USING ERRCODE = '23514';
		END IF;
		IF obligation_requirement = 'artifact_create' AND NEW."kind" <> 'artifact_created' THEN
			RAISE EXCEPTION 'artifact_create obligation requires artifact_created receipt' USING ERRCODE = '23514';
		ELSIF obligation_requirement = 'artifact_update' AND (
			NEW."kind" <> 'artifact_updated' OR NEW."artifact_id" IS DISTINCT FROM obligation_target_artifact_id
		) THEN
			RAISE EXCEPTION 'artifact_update receipt must reference its target artifact' USING ERRCODE = '23514';
		ELSIF obligation_requirement = 'external_action' AND NEW."kind" <> 'external_action_completed' THEN
			RAISE EXCEPTION 'external_action obligation requires external_action_completed receipt' USING ERRCODE = '23514';
		END IF;
		IF obligation_materialized_artifact_id IS NOT NULL AND (
			NEW."artifact_id" IS DISTINCT FROM obligation_materialized_artifact_id
			OR NEW."artifact_revision" IS DISTINCT FROM obligation_materialized_artifact_revision
		) THEN
			RAISE EXCEPTION 'finished work receipt must match the materialized artifact revision' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "finished_work_receipts_validate"
BEFORE INSERT OR UPDATE ON "finished_work_receipts"
FOR EACH ROW EXECUTE FUNCTION "validate_finished_work_receipt"();
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_finished_work_receipts_run_source" ON "finished_work_receipts" ("run_id", "source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_finished_work_receipts_obligation" ON "finished_work_receipts" ("obligation_id") WHERE "obligation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_finished_work_receipts_run_created" ON "finished_work_receipts" ("run_id", "created_at", "id");
--> statement-breakpoint
CREATE FUNCTION "validate_finished_work_satisfied_obligation"() RETURNS trigger AS $$
DECLARE
	checked_obligation_id uuid;
	matching_receipts integer;
	old_obligation_id uuid;
	new_obligation_id uuid;
BEGIN
	IF TG_TABLE_NAME = 'finished_work_obligations' THEN
		new_obligation_id := (to_jsonb(NEW)->>'id')::uuid;
	ELSE
		IF TG_OP <> 'INSERT' THEN
			old_obligation_id := (to_jsonb(OLD)->>'obligation_id')::uuid;
		END IF;
		IF TG_OP <> 'DELETE' THEN
			new_obligation_id := (to_jsonb(NEW)->>'obligation_id')::uuid;
		END IF;
	END IF;
	FOR checked_obligation_id IN
		SELECT DISTINCT candidate
		FROM unnest(ARRAY[old_obligation_id, new_obligation_id]) candidate
		WHERE candidate IS NOT NULL
	LOOP
		SELECT count(*) INTO matching_receipts
		FROM "finished_work_obligations" obligation
		JOIN "finished_work_receipts" receipt
		  ON receipt."obligation_id" = obligation."id"
		 AND receipt."org_id" = obligation."org_id"
		 AND receipt."run_id" = obligation."run_id"
		 AND receipt."thread_id" = obligation."thread_id"
		WHERE obligation."id" = checked_obligation_id
		  AND obligation."state" = 'satisfied'
		  AND (
			(obligation."requirement" = 'artifact_create'
			 AND receipt."kind" = 'artifact_created'
			 AND EXISTS (
				SELECT 1 FROM "artifacts" artifact
				WHERE artifact."id" = receipt."artifact_id"
				  AND artifact."org_id" = obligation."org_id"
				  AND artifact."thread_id" = obligation."thread_id"
				  AND artifact."run_id" = obligation."run_id"
			 ))
			OR (obligation."requirement" = 'artifact_update'
				AND receipt."kind" = 'artifact_updated'
				AND receipt."artifact_id" IS NOT DISTINCT FROM obligation."target_artifact_id")
			OR (obligation."requirement" = 'external_action'
				AND receipt."kind" = 'external_action_completed')
		  );

		IF EXISTS (
			SELECT 1 FROM "finished_work_obligations"
			WHERE "id" = checked_obligation_id AND "state" = 'satisfied'
		) AND matching_receipts <> 1 THEN
			RAISE EXCEPTION 'satisfied finished work obligation requires exactly one matching scoped receipt'
				USING ERRCODE = '23514';
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "finished_work_obligations_satisfied_receipt"
AFTER INSERT OR UPDATE OF "id", "org_id", "run_id", "thread_id", "state", "requirement", "target_artifact_id" ON "finished_work_obligations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_finished_work_satisfied_obligation"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "finished_work_receipts_satisfied_obligation"
AFTER INSERT OR UPDATE OF "obligation_id", "org_id", "run_id", "thread_id", "kind", "artifact_id" OR DELETE ON "finished_work_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_finished_work_satisfied_obligation"();
