-- fast-deploy: expansion-safe
-- Pointer-only recovery state for provider events that arrive before their
-- required execution identity. Provider events remain payload truth.
CREATE TABLE "execution_graph_pending_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"latest_observation_kind" text,
	"latest_native_parent_session_id" text,
	"latest_native_child_session_id" text,
	"latest_relevant" boolean DEFAULT true NOT NULL,
	"latest_execution_required" boolean DEFAULT true NOT NULL,
	"latest_structure_hash" text NOT NULL,
	"first_deferred_delivery_seq" bigint NOT NULL,
	"latest_provider_event_seq" bigint NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	"exhaustion_code" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"applied_structure_hash" text,
	"structural_mismatch_at" timestamp with time zone,
	"structural_mismatch_source_seq" bigint,
	"structural_mismatch_code" text,
	CONSTRAINT "execution_graph_pending_kind_check" CHECK ("latest_observation_kind" IS NULL OR "latest_observation_kind" IN ('spawn', 'control', 'lifecycle')),
	CONSTRAINT "execution_graph_pending_resolution_check" CHECK ("resolution_reason" IS NULL OR "resolution_reason" IN ('applied', 'source_irrelevant', 'edge_only', 'superseded')),
	CONSTRAINT "execution_graph_pending_sequence_check" CHECK ("first_deferred_delivery_seq" >= 0 AND "latest_provider_event_seq" >= 0 AND "attempt_count" >= 0),
	CONSTRAINT "execution_graph_pending_resolved_pair_check" CHECK (("resolved_at" IS NULL) = ("resolution_reason" IS NULL)),
	CONSTRAINT "execution_graph_pending_mismatch_pair_check" CHECK (("structural_mismatch_at" IS NULL AND "structural_mismatch_source_seq" IS NULL AND "structural_mismatch_code" IS NULL) OR ("structural_mismatch_at" IS NOT NULL AND "structural_mismatch_source_seq" IS NOT NULL AND "structural_mismatch_code" IS NOT NULL)),
	CONSTRAINT "execution_graph_pending_exhaustion_pair_check" CHECK (("exhausted_at" IS NULL) = ("exhaustion_code" IS NULL)),
	CONSTRAINT "fk_execution_graph_pending_run" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade,
	CONSTRAINT "fk_execution_graph_pending_provider_event" FOREIGN KEY ("provider_event_id") REFERENCES "provider_events"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE FUNCTION "enforce_execution_graph_pending_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "runs" r
		JOIN "provider_events" p ON p."id" = NEW."provider_event_id"
		WHERE r."id" = NEW."run_id"
			AND r."org_id" = NEW."org_id"
			AND p."run_id" = NEW."run_id"
			AND p."provider" = NEW."provider"
	) THEN
		RAISE EXCEPTION 'execution graph pending source scope mismatch'
			USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_execution_graph_pending_scope"
BEFORE INSERT OR UPDATE OF "org_id", "run_id", "provider", "provider_event_id"
ON "execution_graph_pending_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_execution_graph_pending_scope"();
--> statement-breakpoint
CREATE FUNCTION "protect_execution_graph_pending_run_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."org_id" IS DISTINCT FROM NEW."org_id" AND EXISTS (
		SELECT 1 FROM "execution_graph_pending_observations" p WHERE p."run_id" = OLD."id"
	) THEN
		RAISE EXCEPTION 'cannot change run organization while execution graph pointers exist'
			USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_protect_execution_graph_pending_run_scope"
BEFORE UPDATE OF "org_id" ON "runs"
FOR EACH ROW EXECUTE FUNCTION "protect_execution_graph_pending_run_scope"();
--> statement-breakpoint
CREATE FUNCTION "protect_execution_graph_pending_event_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF (OLD."run_id" IS DISTINCT FROM NEW."run_id" OR OLD."provider" IS DISTINCT FROM NEW."provider") AND EXISTS (
		SELECT 1 FROM "execution_graph_pending_observations" p WHERE p."provider_event_id" = OLD."id"
	) THEN
		RAISE EXCEPTION 'cannot change provider event scope while execution graph pointers exist'
			USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_protect_execution_graph_pending_event_scope"
BEFORE UPDATE OF "run_id", "provider" ON "provider_events"
FOR EACH ROW EXECUTE FUNCTION "protect_execution_graph_pending_event_scope"();
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_execution_graph_pending_source"
ON "execution_graph_pending_observations" USING btree ("org_id", "run_id", "provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX "idx_execution_graph_pending_parent"
ON "execution_graph_pending_observations" USING btree ("org_id", "run_id", "provider", "latest_native_parent_session_id", "resolved_at", "first_deferred_delivery_seq");
--> statement-breakpoint
CREATE INDEX "idx_execution_graph_pending_child"
ON "execution_graph_pending_observations" USING btree ("org_id", "run_id", "provider", "latest_native_child_session_id", "resolved_at", "first_deferred_delivery_seq");
