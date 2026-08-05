# Skynet backend

Hono + Drizzle/Postgres API on **:3201**. Runs (durable event log + SSE),
better-auth (email/password + orgs), skills, and distillation-driven knowledge.

- `bun run dev` — watch-mode server on :3201 (loads `.env`).
- `bun run start` — single (non-watch) server. Use this over `dev` if two
  watchers ever race for the port and nothing binds.
- Postgres: dev DB `skynet` @ `postgres://postgres@localhost:5432`. The Homebrew
  `psql` CLI hangs on a macOS permission dialog — inspect the DB with a small Bun
  script using the `postgres` client instead.

## Testing

`bun test` API suite in `test/`, exercised in-process against the Hono app's
`fetch` handler (no port bound, no LLM calls).

```
bun run test        # prepares the DB, then runs the suite
```

The `test` script runs `test/prepare-db.ts` (drops + recreates `skynet_test` and
pushes the Drizzle schema with drizzle-kit) and then `bun test`. `bunfig.toml`
preloads `test/preload.ts`, which:

- points `DATABASE_URL` at the isolated `skynet_test` database;
- strips `OPENROUTER_API_KEY` / `OPENAI_API_KEY` so distillation degrades to its
  built-in **stub** (deterministic, zero network) and search runs keyword-only;
- sets `WORKER_STEP_DELAY_MS=5` so a scripted run completes in well under a
  second instead of ~12s (the worker honors this knob; unset in normal use).

Suites: `health`, `runs` (create → worker completes → steps persisted →
list/get shapes → SSE replay of `step`+`done`), `auth` (sign-up → session cookie
→ get-session; wrong password → 401), `org` (fresh org sees 0 skills; dev
fallback sees the seeded 7), `skills` (CRUD + run increment), `knowledge`
(ingest stub-distills + stores → idempotent re-ingest skip → keyword search
ranks it → pin → delete). The `worth_saving` drop path needs the live LLM and is
documented as a skipped test (the stub is always `worth_saving`).

Re-run a single suite with `bun test test/runs.test.ts` (after `bun run
test/prepare-db.ts` once).
