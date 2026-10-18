# UseAgent - agent guide

The open-source UseAgent platform: coding agents (Claude Code, Codex, OpenCode,
Pi) working in sandboxed computers, with Postgres as the record of every run.
`CLAUDE.md` imports this file; edit here. This page holds the hard rules, how to
work, and the map of core seams. Read the area guide before touching an area:
[backend](backend/AGENTS.md), [frontend](frontend/AGENTS.md),
[packages](packages/AGENTS.md). Contributor flow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

- `frontend/` Next.js + React product UI on our kit (`components/base`).
- `backend/` Bun + Hono + Postgres/Drizzle control plane, plus the gateway
  (`backend/src/gateway.ts`) that sandboxes call for models and tools.
- `packages/` shared packages (wire contract, harness translation, sandbox
  contract with one plugin per vendor, runner). Packages never import apps.
- `deploy/` release and runtime tooling (native runtime staging, the local
  sandbox image); `infra/self-host/` the self-hosting kit; `apps/desktop/` the
  Electron shell; `docs-site/` the docs; `docs/architecture/` decisions.

No workspace: run `bun install --frozen-lockfile` in `frontend/`, `backend/` and
every `packages/*/` (file: links copy a package and skip its deps).

## Hard rules

- bun everywhere, never npm (CI pins Bun 1.3.14).
- Settled: no engine-UI iframes; the trusted control plane stays outside the
  sandbox; threading is backend truth; Postgres records runs and steps and the
  UI renders that record (plus transient narration), never a live process.
- Native harness: Codex, Claude Code, OpenCode and Pi keep their own driver,
  protocol, session identity, lifecycle and event grammar on every sandbox
  provider, across turns. No compatibility transport; an unsupported pair fails
  closed.
- Retained workspaces: no upgrade, mismatch or rollback deletes a thread's
  sandbox or files. Paths come from the layout of the sandbox attached to the
  run (`/root/work` is not universal). A file on sandbox disk is delivered only
  once publication returns a durable artifact reference.
- Migrations: the boot migrator applies only journal entries whose `when` is
  GREATER than the last applied: stamp strictly above the tail; every new
  migration starts with `-- fast-deploy: expansion-safe` (CI checks it).
- One backend per database (process-local sealing and SSE fan-out); production
  sets `REQUIRE_SINGLE_BACKEND`. Never boot a second backend against a shared
  database: boot recovery takes other processes' runs.
- Names: first-party code is named by FUNCTION and credits sources in its file
  HEADER; third-party product names stay out of our identifiers, files and data
  attributes. Exempt: inert snapshots, licenses and manifests under
  `frontend/vendor/`, and code at a real protocol boundary.
- Copy: the brand is UseAgent; stored and protocol identifiers keep their
  spelling. No em dashes in user-visible strings. The product's former name
  fails the "product-name ratchet" in `backend/test/ratchet.test.ts`; persisted
  values that still carry it are frozen by `backend/test/persisted-names.test.ts`.
- Secrets never reach code, logs, docs, prompts or chat; read named flags,
  never values. Machine notes go in `CLAUDE.local.md` (gitignored).

## How to work

1. Prove the requested outcome before reporting done, at its real boundary; say
   which checks failed or could not run. A green mock is not the behaviour.
2. Fix the failure class through its existing owner (table below), never one
   channel, engine or provider; a new mechanism names its semantic difference.
3. Carry the task through verification. Ask only when information is missing
   or a new consequential action would change the scope.
4. This is the public repository: confirm the checkout, remote and branch
   before committing, and never paste private code, data or keys into it.
5. Checks: root `bun run typecheck` always; backend changes
   `cd backend && bun run test` with `TEST_DATABASE_URL` and `TEST_ADMIN_URL`
   set to your own database (`backend/test/prepare-db.ts` drops and recreates
   it); frontend changes
   `cd frontend && bun run test && bun run lint && bun run build`; package
   changes `cd packages/<name> && bun run test`; always
   `bun test scripts/agent-docs.test.ts`.
6. Own what you use: your branch, database, ports, processes and containers.
   Stop only what you started, never by pattern.
7. Report in plain words: the outcome, the evidence (commands and results), and
   what remains.

## Core seams: for X, go through Y; never Z

| For | Go through | Never |
|---|---|---|
| A new turn or command | `backend/src/commands/service.ts` `acceptRunCommand` (follow-ups via `backend/src/runs/thread-followups.ts`), serialized per thread by `backend/src/runs/thread-lifecycle-lock.ts` | insert runs directly or add a second per-thread queue |
| Stopping a run | `backend/src/runs/stop.ts` `stopRun` (records the cancel, signals the actor) | a status write |
| Delivering a file | `backend/src/artifacts/publish.ts` | a path on sandbox disk as delivery |
| Waking a queued thread | `pumpThread` in `backend/src/worker.ts`, through `backend/src/fleet/pump.ts` and `backend/src/commands/dispatch.ts` `claimNextRun` | dispatch a run outside the command lane |
| Ending a run | `backend/src/runs/finalize.ts` `finalizeRun` for a run that ran (a queued Stop settles in the cancel transaction); transitions in `backend/src/runs/run-state.ts` | a terminal status write that skips both |
| Durable delivery | `backend/src/db/outbox.ts` (`claimDue`, `markSuccess`, `markForRetry`, `markDead`) | a hand-rolled claim loop |
| Database errors and retries | `backend/src/db/pg-errors.ts`, `backend/src/db/transient-retry.ts` `withTransientDbRetry` | matching error text |
| Why a turn failed | `backend/src/engines/turn-failure-classification.ts` | new prose matching elsewhere |
| Provider ids and request limits | `backend/src/provider-gateway/provider.ts`, `backend/src/provider-gateway/limits.ts` | hard-coded caps |
| Spend | `backend/src/runs/spend.ts` | a second price rule |
| Backend settings | `backend/src/env.ts`; sandbox plugins read their own provider settings | new scattered `process.env` parsing |
| Untrusted text in prompts | `backend/src/bots/prompt-safe.ts` `promptSafeJson` | hand-made delimiters |
| Messaging channels | `backend/src/connectors/types.ts` (`Transport`, `Renderer`), `email/` as the worked example | channel logic inside run code |
| Sandbox vendors and engines | one `packages/sandbox-*` plugin + `backend/src/sandboxes/plugins.ts`; native drivers in `backend/src/engines/index.ts` | a vendor switch in core, a substitute engine |
| Backend calls from the UI | `frontend/lib/backend-fetch.ts` `backendFetch` | raw `fetch` to the backend |
| UI primitives and type | `frontend/components/base/` and the type tokens (`frontend/AGENTS.md`) | a new kit, raw hex, `dark:` or arbitrary `text-[Npx]` |

The ratchets, `backend/test/ratchet.test.ts` and
`frontend/components/foundations/ratchet.test.ts`, only shrink: never raise a
baseline to land a change.

## Pull requests

- One change per pull request against `main`, with a test for the behaviour it
  changes; CI must be green. Commit subjects in the imperative, plain words, no
  `type(scope):` prefix.
- Update an agent doc in the same pull request when a path, script or rule it
  cites changes; `scripts/agent-docs.test.ts` fails on a dead citation.

## Before you say done

1. The change goes through the owner in the table above, at the seam every
   caller uses.
2. The checks in "How to work" item 5 pass, with exact commands and results.
3. No secret, former product name, em dash in UI copy or third-party identifier.
4. The outcome is shown working in the app, not only in tests, for UI changes.
