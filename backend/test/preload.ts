/**
 * Test preload — runs before any test file (and, crucially, before any app
 * module is imported), so it wins over Bun's auto-loaded `.env`.
 *
 *  - Points every DB client (Drizzle in src/db, the knowledge store, better-auth,
 *    drizzle-kit) at the isolated `skynet_test` database.
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
  "postgres://postgres@localhost:5432/skynet_test";
process.env.PORT = "3211";

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

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

process.env.WORKER_STEP_DELAY_MS = process.env.WORKER_STEP_DELAY_MS ?? "5";

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
process.env.SLACK_SIGNING_SECRET =
  process.env.SLACK_SIGNING_SECRET ?? "test-signing-secret";
process.env.SLACK_DEFAULT_ENGINE = process.env.SLACK_DEFAULT_ENGINE ?? "mock";
// Slack outbox: kicks still deliver promptly, but push the background relay tick
// far out so it never races a test's explicit processDue(); tiny backoff base so
// any live-timed retry is fast.
process.env.SLACK_OUTBOX_TICK_MS = process.env.SLACK_OUTBOX_TICK_MS ?? "3600000";
process.env.SLACK_OUTBOX_BASE_MS = process.env.SLACK_OUTBOX_BASE_MS ?? "20";
