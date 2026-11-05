# useAgent backend

The backend is the control plane for useAgent. It listens on `:3201` by default and owns auth, org scoping, durable runs, sandbox orchestration, knowledge, memory, skills, playbooks, automations, artifacts, uploads, and external connectors.

## What It Owns

| Area | Main files |
|---|---|
| API bootstrap and cross-cutting middleware | [`src/index.ts`](src/index.ts), [`src/middleware/org.ts`](src/middleware/org.ts) |
| Auth and organization identity | [`src/auth.ts`](src/auth.ts), [`src/db/auth-schema.ts`](src/db/auth-schema.ts) |
| Runs, threads, SSE, finalization, recovery | [`src/runs/routes.ts`](src/runs/routes.ts), [`src/runs/finalize.ts`](src/runs/finalize.ts), [`src/runs/canonicalization-outbox.ts`](src/runs/canonicalization-outbox.ts) |
| Engines and adapters | [`src/engines/index.ts`](src/engines/index.ts), [`src/engines/*.ts`](src/engines) |
| Sandbox providers | [`src/sandboxes/provider.ts`](src/sandboxes/provider.ts), [`src/sandboxes/binding.ts`](src/sandboxes/binding.ts), [`src/runners/`](src/runners) (a developer's own machine as the `local` provider) |
| Trusted capability gateways | [`src/provider-gateway/*.ts`](src/provider-gateway), [`src/knowledge/gateway/*.ts`](src/knowledge/gateway) |
| User provider identity and Codex subscription relay | [`src/provider-connections/*.ts`](src/provider-connections), [`src/engines/t3-codex-subscription.ts`](src/engines/t3-codex-subscription.ts) |
| Knowledge, wiki, memory | [`src/knowledge/*.ts`](src/knowledge), [`src/memory/*.ts`](src/memory), [`src/wiki-gen/*.ts`](src/wiki-gen) |
| Skills, playbooks, automations | [`src/skills/*.ts`](src/skills), [`src/schedules/*.ts`](src/schedules) |
| Artifacts and uploads | [`src/artifacts/*.ts`](src/artifacts), [`src/uploads/*.ts`](src/uploads) |
| GitHub, Slack, email connectors | [`src/github/*.ts`](src/github), [`src/slack/*.ts`](src/slack), [`src/connectors/email/*.ts`](src/connectors/email) |

In Slack, a message that starts with `(aside)` or `!aside` is for the people in the thread and the bot ignores it. `mute` as a reply in a thread the bot roots makes it ignore that thread (one reaction confirms it); `unmute` lifts it.

## Request Lifecycle

1. The frontend posts a run to `POST /api/runs`.
2. The backend resolves org and user server-side, then validates the request against the current org, engine policy, repos, branches, uploads, and skill selection.
3. The run and its durable command record are written atomically.
4. The worker resolves the selected engine through the production provider registry. Codex, Claude Code, OpenCode, and Pi receive their provider-native `ProviderDriver`; sandbox selection never changes the engine protocol.
5. The thread SSE endpoint multiplexes snapshots, runs, steps, live deltas, native frames, and canonical events to the frontend. A reconnect receives a fresh authoritative snapshot. The separate `/api/runs/changes` stream carries live org invalidations only; it has no replay log.
6. Finalization records the terminal run state and enqueues follow-up work such as memory capture, Slack delivery, and canonicalization.

## Trusted Gateway

The backend has two separate trust boundaries:

- `src/provider-gateway/*` mints and verifies signed provider capabilities, then proxies provider traffic with a user connection when present and the tenant credential as fallback.
- `src/knowledge/gateway/*` exposes the trusted MCP tool surface to resident engine sessions. The sandbox gets a short-lived token, not raw database or provider credentials.

Both gateways fail closed:

- org and thread identity come from server-side token claims.
- upstream provider hosts are HTTPS-only outside local development.
- provider retries happen before a response is exposed to the sandbox. The gateway keeps one request body, bounds retry count and delay, honors provider retry directives, and marks terminal auth, billing, quota, or exhausted-budget responses non-retryable.
- built-in gateway tools use a process-wide dispatch index for the base and conditional capability families. Child sessions, Loop login, and Slack are advertised only when their trusted context is present.
- compact discovery is opt-in and advertises two separately dispatched meta tools instead of the full catalog. Current tests prove uniqueness across the base and conditional families, not one global namespace that also includes the meta tools or external MCP servers.

Managed ChatGPT/Codex accounts use a separate transport from API-key traffic.
The backend launches Codex app-server with the user's scoped managed home and
issues a one-use relay URL bound to the exact tenant, user, thread, run,
connection epoch, model, sandbox generation, remote environment, and working
directory. T3 receives that URL, not OAuth state. The sandbox launches only
Codex exec-server; a loopback bridge injects Cube or Daytona preview headers.
Every relay frame is reauthorized, queues and frames are bounded, and the
provider thread is durably bound to the same connection epoch before resume.
These are locally tested boundaries; hosted execution is not claimed until the
guarded canary passes.

Readiness follows the selected credential mode rather than the engine name.
`ENGINE_AUTH_MODE_CODEX=subscription` requires the exact connected account and
does not depend on, mutate, or promote `PROVIDER_HEALTH_OPENAI`. The compatibility
default is `hybrid`, which prefers the managed subscription and falls back to the
signed provider gateway when no connected account exists. `provider_gateway`
never queries managed subscription state. Release evidence records one stable
auth mode per engine and promotes only the engines present in the complete
evidence matrix; an unproven OpenCode credential cannot block or be promoted by
a subscription-only Codex release.

## Engine Adapters

`src/engines/index.ts` is the production provider registry, and
`src/worker.ts` dispatches real turns through `runProviderTurn`. Runtime
orchestration may provision or supervise an engine, but it does not replace the
engine's native driver, protocol, session identity, lifecycle, or event grammar.

| Adapter | Where it runs | Notes |
|---|---|---|
| `opencode` | Resident OpenCode runtime inside the thread sandbox | Uses the native OpenCode driver through the shared runtime lifecycle for start, resume, steer, questions, and cancel. |
| `claude` | Resident Claude Code runtime inside the thread sandbox | Uses the native Claude Code driver and event grammar for start, resume, steer, approvals, questions, and cancel where supported. |
| `codex` | Resident Codex runtime inside the thread sandbox | Uses the native Codex driver and event grammar for start, resume, steer, approvals, questions, and cancel where supported. |
| `pi` | Resident Pi runtime inside the thread sandbox | Uses the native Pi driver and event grammar. |
| `daytona` | Alias for the OpenCode path | Keeps old thread rows and replies readable after the provider rename. |
| `mock` | Scripted worker path | Used for deterministic local runs and tests. |

Cube, Daytona, and Box change only the execution substrate. If one cannot host
an engine's native runtime, readiness reports that engine/provider pair as
unsupported and stops before the turn starts. It must not silently select
another engine or a reduced lifecycle. `daytona` and `claude-sdk` remain
aliases for older rows, but aliases resolve to the same native engine contract.

### Capability Notes

`src/engines/capabilities.ts` is the source of truth for what the UI may show.

- Streaming text, tool progress, commands, and the sandbox terminal are available for every engine.
- File diffs, child sessions, reasoning, plans, and usage are honest only where the adapter really supports them.
- Desktop and knowledge tools are runtime resources, not pure protocol negotiation. They are only true when the session actually has them.
- Runtime orchestration may expose approvals and authoritative history only when the selected native driver proves those capabilities.

## Sandbox Provider Plugins

Every sandbox vendor is a plugin package. `packages/sandbox-contract` holds the
provider-neutral contract (`SandboxProvider`, `SandboxHandle`, the
`SandboxProviderPlugin` shape and the shared create/get/list conformance
helper); `packages/sandbox-daytona`, `packages/sandbox-cube` and
`packages/sandbox-box` each export one plugin that owns its API client, env
config, credential validation, preview auth headers and runtime layout (home
directory, root or not); `packages/sandbox-local` is the plugin for a
developer's own machine, an RPC client over the runner link the backend holds
(`src/runners/`, `packages/runner`). `src/sandboxes/plugins.ts` is the registry and
`src/sandboxes/provider.ts` the env-coupled selector (`SANDBOX_PROVIDER`);
nothing else in the backend switches on a vendor name.

Adding a vendor: create `packages/sandbox-<vendor>` from the Box package,
export its plugin, add one line to the registry, add the package to the root
`typecheck` script, the CI `package-test` matrix and `Dockerfile.backend`.
Run its conformance test plus a live smoke against a real account before
sign-off; the in-memory fakes hide vendor quirks.

The matrix describes implemented source capabilities, not current hosted
proof.

| Capability | Daytona | Cube | Box | Local | Notes |
|---|---|---|---|---|---|
| Commands | Yes | Yes | Yes | Yes | Box runs sync commands under a 600 s cap and longer ones detached with an exit marker. Local runs them detached inside the container with pid, log and exit files. |
| Persistent command sessions | Yes | Yes | Yes | Yes | Box sessions are pid-file process groups under `/home/user/.useagent`. Local sessions live under `/tmp/useagent/sessions` with a FIFO for input. |
| PTY | Yes | Yes | Yes | Yes | The frontend terminal uses this path; Box uses its managed interactive SSH transport; Local execs inside the container and applies resizes from inside. |
| File upload and download | Yes | Yes | Yes | Yes | Used for repo materialization and artifacts. Local moves files as byte streams over the link. |
| Preview links | Yes | Yes | Yes | Yes | Auth headers come from the plugin: token headers for Daytona and Cube, a port-auth cookie for Box. Local links are loopback forwarders on the plane, so the proxies are unchanged. |
| Native computer use API | Yes | No | No | No | |
| Desktop workstation | Yes | Yes | No | Untested | Cube drives the workstation through the trusted gateway. The local image carries the desktop stack; it has not been certified. |
| Recording | Yes | Yes | No | Untested | Daytona uses native recording. Cube uses the X11 and FFmpeg path. |
| Resume after timeout | Yes | Yes | Yes | Yes | Box archives on its absolute TTL and resumes on the next start. The runner stops idle containers by their auto-stop label and starts them again on demand. |
| Runs as root | Yes | Yes | No | No | Box and Local run as `user` (uid 1000); all providers retain the same native engine drivers under their declared home/workspace layout. |
| Labels | Native | Native | Control plane | Control plane | Box and Local labels live in `sandbox_labels`; the sandbox cannot rewrite them. |
| Pause, checkpoint, snapshot primitives in the shared interface | No | No | No | No | This is still a bounded roadmap item. |

The `local` column is certified by hand on one machine with
`deploy/local-sandbox/certify/`; the record is
`deploy/hetzner/evidence/local/certification-2026-09-08.md`. The hosted
release gate proves the matrix on Cube and cannot attach a developer's
machine.

The library default is Daytona unless `SANDBOX_PROVIDER=cube` or `box` is
set. The current Hetzner bootstrap configures Cube explicitly. Box is verified
live (create, commands, files, previews, sessions, archive/resume, delete);
hosted Daytona credentials, preview-header behavior, confirmed deletion, and
latency remain unproven for the current tree. With `USER_COMPUTERS=on`, a
user's stored Daytona or Box key (Settings) runs that user's threads instead
of the deployment's provider.

## Skills, Knowledge, Memory, Playbooks, Automations

### Skills and playbooks

- Skills and playbooks share one immutable catalog substrate.
- `src/skills/catalog.ts` provides bounded catalog pages and a prefill view for the model.
- `src/skills/import-routes.ts` and `src/skills/routes.ts` expose the org skill surface.
- The gateway advertises skill metadata as untrusted text only. It is for semantic selection, not instruction following.
- Playbooks are the same substrate as skills, with `kind=playbook`.

### Knowledge

- `src/knowledge/gateway/tools.ts` exposes `knowledge_search` and `knowledge_read`.
- Knowledge search is read-only and org-scoped.
- Retrieval is recorded durably on the run as a knowledge event.
- The gateway also serves the wiki generation flow in `src/wiki-gen/routes.ts`.
- Wiki structure generation validates the model response with the existing
  bounded structure parser and performs a bounded repair turn when a
  probabilistic provider returns prose or malformed XML. A higher-priority
  system instruction marks repository data as untrusted source material.
  `WIKI_GEN_STRUCTURE_RETRIES` defaults to `2` and is capped at `5`; release
  canaries reject any failed wiki page instead of bypassing the generation
  check.

### Memory

- `src/memory/routes.ts` and `src/knowledge/gateway/memory-tools.ts` implement the optional memory layer.
- The layer is off when `MEMORY_API_URL` is unset.
- When enabled, reads and writes are scoped server-side to the active run and team boundary.
- Memory is reference material, not instructions.

### Automations

- `src/knowledge/gateway/automation-tools.ts` manages scheduled automations.
- New automations are always created disabled.
- Enabling requires an explicit confirmation flag.
- Scheduled firings use the same durable run lane as interactive work.
- Create, update, delete, and fire mutations publish tenant-scoped invalidations after the durable mutation. The Automations list and history drawer refetch from the shared browser EventSource, with bounded polling retained as recovery.
- The invalidation bus is process-local. It supports the enforced single-backend deployment, not horizontal fanout.

## Development

The backend package has its own scripts:

```bash
bun run dev
bun run start
bun run gateway
bun run test
bun run e2e
bun run soak
```

Notes:

- `bun run dev` runs the backend in watch mode on `:3201`.
- `bun run start` runs the backend once, without watch mode.
- `bun run gateway` starts the sandbox gateway on `:3202`.
- `bun run test` prepares `useagent_test` and then runs the backend test suite; it requires a reachable PostgreSQL test database.
- `bun run soak` runs the manual runtime checks; live-provider execution requires an explicit cost budget.

### Local Environment

The important variables are:

- `DATABASE_URL` for Postgres.
- `FRONTEND_ORIGIN=http://localhost:3400` for local browser auth and CORS.
- `BETTER_AUTH_URL=http://localhost:3201` for auth redirects and
  `BETTER_AUTH_SECRET` for session signing. Set `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` for Google sign-in. Without `SIGNUP_OPEN` (below)
  production accepts existing users only; their email/password sign-in remains
  available while Google is optional.
- `SIGNUP_OPEN=1` opens email/password sign-up behind a mailed confirmation
  (needs `CONNECTOR_EMAIL_HOST` and `CONNECTOR_EMAIL_FROM`); `SIGNUP_ALLOWED_DOMAINS`
  and `SIGNUP_INVITE_CODE` narrow it.
- `ENABLED_ENGINES` to opt extra engines into the backend picker.
- `ENGINE_TIMEOUT_MS` and `ENGINE_MAX_MS` set optional time limits on a coding-engine
  task. Both are in milliseconds and both are off by default, so a task runs until it
  finishes or someone stops it. `ENGINE_TIMEOUT_MS` stops a task after that long with
  no activity; each new step and each native frame starts the wait again. `ENGINE_MAX_MS`
  is a hard cap on the whole task, however active it is. A value that is unset, empty,
  not a number or not above zero turns that limit off, and a value above 2147483647
  (about 24.8 days, the longest timer delay) is treated as that maximum. Neither limit
  applies to Chat tasks yet.
- `LAB_ACCOUNTS=owner@example.com,second@example.com` lists the accounts that may
  open the component lab (`/lab`) in production; unset, nobody can. Development
  mode keeps it open.
- `OPERATOR_ACCOUNTS=owner@example.com` lists the accounts that run the deployment.
  Only they see Settings > Infrastructure (the managed sandbox vendor, the
  provider preference, the Daytona and Box accounts), reach the routes behind it
  (`/api/operator/*`, `/api/sandbox-preference`, the Daytona and Box provider
  connections) and read a vendor name on a run; everyone else gets 404 there and
  reads "Cloud". Unset, nobody does. Stored connections and preferences keep
  applying to runs. Development mode keeps it open. These accounts are also
  exempt from the sandbox minutes cap and from `ORG_CREATE_LIMIT_PER_USER`
  (default 2 organisations created per person), in every mode.
- `PROVIDER_ACCOUNTS=cerebras:owner@example.com,second@example.com;openai:third@example.com`
  offers a model provider only to the listed accounts. A provider named there
  leaves every catalog, refuses runs like an unknown model, has no Settings card
  and gets no gateway token for anyone else; a provider not named is open to all.
- `SANDBOX_PROVIDER=daytona|cube|box` to choose the sandbox provider (Box: `BOX_API_KEY`, optional `BOX_SNAPSHOT`, `BOX_MACHINE_TYPE`; or per-user keys via Settings with `USER_COMPUTERS=on`). A developer's own machine (`local`) is never the deployment default: it is chosen per run while that user's enrolled runner is connected.
- `LOCAL_RUNNERS=off` keeps every run on the deployment's provider even when a user's machine is connected. Whether an organization may run threads on members' machines, and lend those machines' Codex and Claude logins, is its runner policy (`PUT /api/runners/policy`).
- `MEMORY_API_URL` and related memory variables to enable the optional team-memory layer.
- `GITHUB_TOKEN` or `GITHUB_APP_*` for repository access.
- The Free model lane (OpenRouter `:free` variants for OpenCode) is free on the
  member's own OpenRouter key: a member connects it in Settings and free
  models cost them nothing; the deployment's keys never serve a member's run
  or chat turn (Chat runs on the member's key or the organisation's stored
  `OPENROUTER_API_KEY` secret, and `CHAT=off` hides it).
  The lane qualifies itself: at boot and every 15 minutes the backend
  discovers the public catalog and runs short low-priority probe runs (at most
  96 a day, one at a time, never while deployment admission is closed) and
  advertises the last generation it published. Probe runs belong to
  `FREE_MODEL_QUALIFIER_ORG_ID`, else the deployment's primary organization
  (`USEAGENT_PRIMARY_ORG_ID`), and spend that organization's stored OpenRouter
  key; without one the lane discovers but does not probe.
  `FREE_MODEL_QUALIFIER=off` is the kill switch (the lane then stays at its
  last generation). OpenCode Zen's free models join the lane once
  `OPENCODE_API_KEY` and `PROVIDER_HEALTH_OPENCODE=verified` are set; Zen's
  free marker is the lane's own, so that account must hold no credit balance
  with auto-reload off.
- the provisioning scripts provisions one backend, a separate restricted gateway service, Cube, memory, and systemd wiring. Production sets `REQUIRE_SINGLE_BACKEND=true` because ambient org invalidation is process-local.
- `infra/self-host/README.md` documents the Terraform scope. It only manages Cloudflare DNS.

## Current Versus Bounded

### Current

- Single-backend operation is enforced with a database lock.
- Runs, SSE, canonicalization, uploads, artifacts, native artifact export, memory capture, and connector delivery are all wired.
- The provider gateway and knowledge gateway are real backend services, not placeholders.
- The worker routes production turns through the provider registry. Codex, Claude Code, OpenCode, and Pi retain their native `ProviderDriver` lifecycles on every supported sandbox provider.
- Daytona, Cube, Box and an enrolled developer's machine (`local`) all run real sandboxes, with the capability differences in the matrix above.
- Better Auth owns sign-in and organizations; existing local user, organization and membership IDs remain the tenancy model. Existing-account password sign-in and configured Google sign-in are available; public signup is closed.
- Desktop readiness and repair cover noVNC, RFB, the desktop session process set, browser CDP, and the restricted CDP relays. Failure degrades the advertised capability instead of failing the coding run.

### Bounded Roadmap

- Multi-replica backend operation is not supported yet.
- The org-change SSE bus must move to durable pub/sub or outbox fanout before multi-replica operation.
- The sandbox provider interface still lacks explicit pause, checkpoint, and snapshot operations.
- Hosted Daytona credentials, preview isolation, deletion, and latency still require release-gate evidence.
- Artifact storage is still local to the backend node.
- Rich Office/PDF binary round-trip editors, PDF import, and shared object
  storage remain future work. The current presentation and PDF editors operate
  on bounded slide-JSON and text companion state.

## See Also

- [`../README.md`](../README.md) for the repo map.
- [`../frontend/README.md`](../frontend/README.md) for the UI layer.
- [`../packages/agent-client/README.md`](../packages/agent-client/README.md) for the browser/runtime client contract.
- [`../packages/agent-harness/README.md`](../packages/agent-harness/README.md) for the canonical engine contract.
- [`../memory/README.md`](../memory/README.md) for the optional memory service.
