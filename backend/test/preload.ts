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

process.env.WORKER_STEP_DELAY_MS = process.env.WORKER_STEP_DELAY_MS ?? "5";

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
process.env.SLACK_SIGNING_SECRET =
  process.env.SLACK_SIGNING_SECRET ?? "test-signing-secret";
process.env.SLACK_DEFAULT_ENGINE = process.env.SLACK_DEFAULT_ENGINE ?? "mock";
