/**
 * Test preload — runs before any test file (and, crucially, before any app
 * module is imported), so it wins over Bun's auto-loaded `.env`.
 *
 *  - Points every DB client (Drizzle in src/db, the knowledge store, better-auth,
 *    drizzle-kit) at the isolated `useagent_test` database.
 *  - Strips OPENROUTER_API_KEY / OPENAI_API_KEY so distillation degrades to its
 *    keyless STUB path and embeddings degrade to keyword-only — zero LLM calls,
 *    fully deterministic. (The app reads these keys lazily, so deleting them here
 *    is sufficient.)
 *  - Collapses the scripted worker delay so a run completes in well under a
 *    second instead of ~12s.
 *  - Enables the env-gated Slack adapter with fixed test secrets (the mount is
 *    decided at src/index import time, so this must be set BEFORE any app
 *    import) and pins its runs to the fast `mock` engine. Outbound Slack calls
 *    are intercepted via setSlackClientForTest — nothing hits the network.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres@localhost:5432/useagent_test";
process.env.PORT = "3211";

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.WIKI_GEN_STRUCTURE_RETRIES;

// Strip GitHub creds so the unit suite is hermetic — no live GitHub calls (repo
// listing / installation-token mint) leak in from backend/.env. The e2e:real
// suite runs as a standalone script (no [test] preload), so it keeps them.
for (const k of [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ORG",
  "GITHUB_OWNER",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
]) {
  delete process.env[k];
}

// Never let a dev .env's periodic skill resync / code indexer start its boot
// sweep inside the unit suite (the app import runs startSkillsResync +
// startCodeIndex).
delete process.env.SKILLS_RESYNC_INTERVAL_MIN;
delete process.env.CODE_INDEX_INTERVAL_MIN;

process.env.WORKER_STEP_DELAY_MS = process.env.WORKER_STEP_DELAY_MS ?? "5";

// The Free model lane refreshes itself from OpenRouter's public catalog on
// manifest traffic. Pin the SHARED cache's fetcher to an instant failure so no
// test ever leaves the process (the lane then serves its curated seed); suites
// that exercise the refresh install their own fixture fetcher per test.
const { setFreeModelCatalogFetcherForTest } = await import(
  "../src/runs/free-model-lane"
);
setFreeModelCatalogFetcherForTest(async () => new Response(null, { status: 503 }));

// Fleet capacity defaults are conservative for the single prod host; the general
// unit suite predates capacity gating and submits freely, so open the limits wide
// here (a deploy keeps the real defaults). The dedicated fleet tests set small
// limits at runtime to exercise queueing deterministically.
process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES =
  process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES ?? "100000";
process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES =
  process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES ?? "100000";
process.env.FLEET_ORG_MAX_QUEUE_DEPTH =
  process.env.FLEET_ORG_MAX_QUEUE_DEPTH ?? "1000000";
// Fast reconciler tick when a test starts the loop explicitly.
process.env.FLEET_TICK_MS = process.env.FLEET_TICK_MS ?? "200";
// The general suite drives admission explicitly (no background loop pumping
// queued work behind tests' backs); the dedicated fleet tests start it themselves.
process.env.FLEET_RECONCILER_AUTOSTART = process.env.FLEET_RECONCILER_AUTOSTART ?? "0";

// Unit fixtures intentionally exercise every provider lane without making paid
// calls. Mark those synthetic lanes as proven so the same centralized
// acceptance gate used in production remains active during tests.
process.env.ENABLED_ENGINES = "opencode,claude,codex";
for (const engine of ["OPENCODE", "CLAUDE", "CODEX"] as const) {
  process.env[`ENGINE_READINESS_${engine}`] = "verified";
}
for (const provider of ["ANTHROPIC", "OPENAI", "OPENROUTER"] as const) {
  process.env[`PROVIDER_HEALTH_${provider}`] = "verified";
}

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
process.env.SLACK_LEGACY_TEAM_ID = process.env.SLACK_LEGACY_TEAM_ID ?? "T0TESTTEAM";
process.env.SLACK_SIGNING_SECRET =
  process.env.SLACK_SIGNING_SECRET ?? "test-signing-secret";
delete process.env.SLACK_APP_ID;
delete process.env.SLACK_CLIENT_ID;
delete process.env.SLACK_CLIENT_SECRET;
delete process.env.SLACK_OAUTH_REDIRECT_URI;
process.env.SLACK_DEFAULT_ENGINE = process.env.SLACK_DEFAULT_ENGINE ?? "mock";
// Slack outbox: kicks still deliver promptly, but push the background relay tick
// far out so it never races a test's explicit processDue(); tiny backoff base so
// any live-timed retry is fast.
process.env.SLACK_OUTBOX_TICK_MS = process.env.SLACK_OUTBOX_TICK_MS ?? "3600000";
process.env.SLACK_OUTBOX_BASE_MS = process.env.SLACK_OUTBOX_BASE_MS ?? "20";
