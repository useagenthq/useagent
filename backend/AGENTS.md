# backend - agent guide

Bun + Hono + Postgres/Drizzle: the control plane and the gateway. `CLAUDE.md`
imports this file; edit here. Root rules: [../AGENTS.md](../AGENTS.md). Paths
below are relative to `backend/`.

## Processes

- `src/index.ts` is the backend (port 3201). Boot takes the single-backend lock
  (`src/db/single-backend.ts`), migrates, recovers stale runs, starts the
  periodic jobs and mounts every route. A new router is session-protected
  unless `src/middleware/org.ts` lists it public (in development, `allowDevOrg`
  in `src/env.ts` admits a seeded identity); API keys reach only what
  `src/middleware/bearer.ts` allows.
- `src/gateway.ts` is the gateway (port 3202) that sandboxes call for models
  and gateway tools. It runs on a restricted database role
  (`GATEWAY_DATABASE_URL`, required outside development): a table or column it
  touches needs its grant in `src/db/gateway-grants.ts`.
- Turns run inside the backend (`src/worker.ts`; `mock` is
  `src/worker-mock.ts`). Engines keep their native session across turns; a
  thread keeps its sandbox.

## Reuse the owner of each invariant

| For | Owner |
|---|---|
| Accepting a turn or command | `src/commands/service.ts` `acceptRunCommand` (and its connector, internal and unattended forms), serialized per thread by `src/runs/thread-lifecycle-lock.ts` `withThreadLifecycleLock` |
| Dispatching a queued turn | `pumpThread` (`src/worker.ts`) through `src/fleet/pump.ts` `pumpThreadWithGate` and `src/commands/dispatch.ts` `claimNextRun` |
| A follow-up in an existing thread | `src/runs/thread-followups.ts` (`acceptExistingThreadFollowup`, `acceptThreadFollowup`): resolves the parent run, then accepts through `acceptRunCommand` (`src/commands/service.ts`) |
| Stopping a run | `src/runs/stop.ts` `stopRun`: records the cancel (`src/commands/cancel.ts` `acceptRunCancel`, which settles a queued run itself) and signals the running actor |
| Publishing a deliverable | `src/artifacts/publish.ts` (`publishSandboxArtifact` for sandbox files, `publishTrustedArtifact` for control-plane outputs) |
| Capabilities handed to a sandbox | `src/security/signed-capability.ts` (`mintSignedCapability`, `verifySignedCapability`) |
| Ending a run that ran | `src/runs/finalize.ts` `finalizeRun`; transitions in `src/runs/run-state.ts` (`markRunStarted`, `completeRun`) |
| Answering an engine's approval or question | `src/runs/provider-session-routes.ts` `registerProviderSessionRoutes`: checks the session binding and auth epoch, then answers the live session (no new turn) |
| Recording engine events | `src/runs/provider-events.ts` (`drainProviderEvents`), `src/runs/canonical-events.ts`, `src/runs/canonicalization-outbox.ts` |
| Which sandbox and workspace a run uses | `src/sandboxes/binding.ts` `resolveRunSandbox`, `src/sandboxes/workspace.ts` `resolveAttachedSandboxWorkspaceRoot` |
| Durable delivery | `src/db/outbox.ts` (`claimDue`, `markSuccess`, `markForRetry`, `markDead`, `backoffAt`), used by the memory, learning and canonicalization outboxes |
| A periodic job | a `start*` function started at boot; the reconcile loop's `createTickGuard` (`src/runs/recovery.ts`) is the overlap guard to copy |
| Database errors and retries | `src/db/pg-errors.ts` (`isLockTimeout`, `isTransientDbError`), `src/db/transient-retry.ts` `withTransientDbRetry` |
| Why a turn failed | `src/engines/turn-failure-classification.ts` `classifyTurnFailure` |
| What reaches an upstream model | `src/provider-gateway/request-policy.ts`, limits in `src/provider-gateway/limits.ts` |
| Untrusted text in prompts | `src/bots/prompt-safe.ts` `promptSafeJson` |
| Secrets in text | `src/secrets/redact.ts` |
| Messaging channels | `src/connectors/types.ts` (`Transport`, `Renderer`), `src/connectors/email/` as the worked example |

The guard tests: `test/ratchet.test.ts` (an 800-line file cap with shrink-only
baselines, the dependency law, the product-name ratchet) and
`test/persisted-names.test.ts` (stored names stay frozen).

## Rules from history, most violated first

Evidence and tests:

1. Prove the behaviour at its real boundary, never a mock of it: the real cancel
   (`acceptRunCancel`), the real route, the gateway's restricted role, a fresh
   process. Name the layer each test proves; the rest is "not verified".
2. A test must fail on the code before the fix: assert independent literal
   outcomes (never the production function as its own oracle), and put the
   failure, restart and legacy-row cases beside the happy path.
3. Access and money changes prove wrong-owner, replay, crash and interleaving
   cases with controlled ordering (hold a lock, wait for its waiter); a sleep
   proves no race.
4. Report green, "sent" or "delivered" only on complete positive evidence. An
   unknown outcome stays unknown: a lost answer is not a failure, an unanswered
   read is not "nothing found", an enqueued message is not delivered.

Seams and access:

5. Fix the class where every caller and writer routes through; grep them all
   and fix every site. A parallel mechanism, or a fix for one channel, engine
   or provider while the shared path stays broken, is not a fix.
6. Authorize at the effect: re-check in the same transaction as the write, on
   every entry path (replay, delivery, dispatch). Fail closed on missing
   identity or a failed lookup; a contested change is one conditional update.
7. Every ingress (web, API, Slack, bots, child sessions, schedules) goes through
   `acceptRunCommand` (`src/commands/service.ts`); the backend resolves and
   authorizes the target thread (`src/runs/thread-followups.ts`) first, so a
   client's thread id is only a lookup key.

Waits, locks and durability:

8. Bound every wait: transaction-local lock and statement timeouts, a timeout
   on every network call; `Promise.race` is not a bound. When a deadline fires,
   stop the work and fence its later writes. A deadline signal shared by
   several waits must not be `AbortSignal.timeout` (Bun 1.3.14 drops its timer
   once the first wait lets go).
9. No network, provider or file I/O inside a terminal transaction or under a run
   or lifecycle lock: read caches, keep the transaction short, deliver after
   commit. Persist before you publish (SSE, Slack, memory).
10. Delivery writes are fenced to the claim that took the row; a lease outlives
    its work's deadline; a lapsed lease is not proof a process died.
11. Side work (memory, learning, notices) never fails a run.

Releases and schema:

12. Every release crosses live work: the old backend serves until the swap, so
    schema changes are additive and read-first, wire changes stay decodable by
    the released web client, no backfill races the old backend, and retained
    workspaces and live sessions survive.
13. Migrations are hand-written SQL that starts with
    `-- fast-deploy: expansion-safe`, appended to `drizzle/meta/_journal.json`
    with `when` strictly above the tail (the tail is a synthetic stamp ahead of
    the clock, so `Date.now()` lands below it and never runs). Re-read the tail
    before merging and restamp if another migration landed first. Never edit a
    merged migration.
14. A rename never find-replaces stored or wire identifiers;
    `test/persisted-names.test.ts` freezes them.
15. A path a container reads from env (`RUNS_ROOT`, `ARTIFACT_STORAGE_DIR`) must
    exist and be writable inside that container: with a read-only root, mount
    it at that same path in the compose file you deploy with.

Engines and providers:

16. Engine parity: a change to approvals, questions, child events, cancel,
    resume or artifacts is checked on every engine it touches (Codex, Claude
    Code, OpenCode, Pi); decide by capability, never by engine id. An engine you
    could not run is "not verified", never substituted. Every native request
    (approval, question, JSON-RPC call) gets an answer.
17. Read a provider failure by its status or code, not its prose, and test a
    parser against every documented code.
18. Upstream requests forward exactly what the request policy checked;
    allowlists stay closed.

Environment hygiene:

19. Tests use your own throwaway database: set `TEST_DATABASE_URL` and
    `TEST_ADMIN_URL` explicitly every time (the unset default names a local
    database other work may share), knowing prepare-db drops and recreates the
    target. Never boot a second backend against a shared database.
20. Tests do not reach the network: stub every outbound client, and restore any
    env a test changes. A `.env` in the checkout is auto-loaded by `bun test`;
    keep secrets out of it while testing.
21. Secrets never reach logs, errors, argv, traces, model context or docs:
    redact, never narrow a redaction pattern, and name variables, never values.
22. A red test is a signal: find the cause; never rerun until green, raise a
    timeout or baseline, add a retry or delete the test to land a change.
23. Stop only processes you started, never by pattern; delete only sandboxes
    you created and confirm each deletion through the provider.

## Run and test

```sh
bun install --frozen-lockfile                 # also in every packages/*/
bun run dev                                   # backend on :3201 (bun run gateway: :3202)
TEST_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres \
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/<own_db> bun run test
```

- `bun run test` recreates the database, runs the suite, then the Slack suite
  on its own. One file: `bun test --timeout 30000 test/<file>.test.ts` with the
  same variables set.
- `tsconfig.json` covers `src/` only; root `bun run typecheck` covers the
  backend with the frontend and packages.
- Manual, never in CI: `bun run e2e`, `bun run soak` (real sandboxes and real
  model spend).

## Before you say done

1. The change goes through the owner in the table, or the pull request names
   the semantic difference that needs a new mechanism.
2. Root `bun run typecheck` and `bun run test` on your own database pass; the
   ratchets pass without a raised baseline.
3. Each test fails on the old code; access changes have wrong-owner, replay and
   crash cases; lifecycle changes are checked on every engine they touch.
4. A schema or wire change says how old rows, the old backend and the released
   client cross the release; a new gateway-read table has its grant.
5. No secret in code, logs or the commit; your database and processes stopped.

## Review prompt

```
Review the pull request's diff against backend/AGENTS.md. Check: each new mechanism
names the existing owner it reuses; the fix sits where every caller routes through, at
every site; access is checked at the effect on every entry path; unknown outcomes stay
unknown; delivery writes are fenced; waits are bounded and deadlines stop later writes;
tests hit the real boundary, fail on the old code and use controlled ordering, not
sleeps; schema and wire changes cross a release (old backend, old rows, released client);
migrations are expansion-safe and stamped above the tail. P1 = hang, data lost or
duplicated, access wrong, unrecoverable state, duplicated primitive. End with
VERDICT: APPROVE or VERDICT: CHANGES.
```
