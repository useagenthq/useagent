-- fast-deploy: expansion-safe
-- Versioned provider/runtime authority for current native sessions. Existing
-- rows remain valid with NULL and use the legacy compatibility path.
ALTER TABLE "runs" ADD COLUMN "provider_session" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_provider_session_shape_check" CHECK (
  "provider_session" IS NULL OR (
    jsonb_typeof("provider_session") = 'object'
    AND "provider_session" ?& ARRAY[
      'version', 'provider', 'nativeSessionId', 'protocol',
      'generation', 'runtime', 'authEpoch'
    ]
    AND jsonb_typeof("provider_session"->'version') = 'number'
    AND "provider_session"->>'version' = '1'
    AND jsonb_typeof("provider_session"->'provider') = 'string'
    AND length("provider_session"->>'provider') BETWEEN 1 AND 64
    AND "provider_session"->>'provider' = CASE
      WHEN "engine" = 'daytona' THEN 'opencode'
      WHEN "engine" = 'claude-sdk' THEN 'claude'
      ELSE "engine"
    END
    AND jsonb_typeof("provider_session"->'nativeSessionId') = 'string'
    AND length("provider_session"->>'nativeSessionId') BETWEEN 1 AND 1024
    AND "provider_session"->>'nativeSessionId' = "engine_session_id"
    AND jsonb_typeof("provider_session"->'protocol') = 'string'
    AND length("provider_session"->>'protocol') BETWEEN 1 AND 256
    AND jsonb_typeof("provider_session"->'generation') = 'number'
    AND (("provider_session"->>'generation')::numeric % 1) = 0
    AND ("provider_session"->>'generation')::numeric >= 1
    AND jsonb_typeof("provider_session"->'runtime') = 'object'
    AND "provider_session"->'runtime' ?& ARRAY['kind', 'id']
    AND "provider_session"->'runtime'->>'kind' IN ('sandbox', 'managed')
    AND jsonb_typeof("provider_session"->'runtime'->'id') = 'string'
    AND length("provider_session"->'runtime'->>'id') BETWEEN 1 AND 256
    AND (
      "provider_session"->'runtime'->>'kind' = 'managed' OR
      "provider_session"->'runtime'->>'id' = "sandbox_id"
    )
    AND (
      "provider_session"->'authEpoch' = 'null'::jsonb OR (
        jsonb_typeof("provider_session"->'authEpoch') = 'string'
        AND length("provider_session"->>'authEpoch') BETWEEN 1 AND 256
      )
    )
  ) IS TRUE
) NOT VALID;
