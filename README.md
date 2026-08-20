# skynet

Skynet is a multi-package repository for the Loop agent platform. The repo has one product UI, one backend control plane, and shared TypeScript packages that define the cross-package contracts.

## Repo Map

| Path | What it owns |
|---|---|
| `frontend/` | Next.js UI. Chat, agent sessions, skills, playbooks, wiki, artifacts, secrets, learnings review, automations, and settings. |
| `backend/` | Hono + Postgres control plane. Auth, org scoping, runs, sandboxes, engines, knowledge, memory, skills, automations, artifacts, uploads, and connectors. |
| `packages/agent-client/` | Runtime-neutral client for thread events, SSE reconnect, reducers, selectors, and typed API helpers. |
| `packages/agent-harness/` | Provider-neutral canonical event and control contract for engine adapters. |
| `packages/artifact-formats/` | Native DOCX, XLSX, PPTX, and PDF artifact renderers plus bounded Office text extraction. |
| `packages/artifact-workspace/` | Provider-neutral workpiece kinds, actions, and native export capability matrix shared by backend and frontend. |
| `packages/conformance/` | Deterministic, framework-free contract tests for the shared client and harness packages. It does not run live providers. |
| `memory/` | Optional team-memory service docs and bring-up notes. |
| `infra/terraform/prod/` | Terraform for Cloudflare DNS only. |

## Product Surface

- `frontend/app/page.tsx` is the lightweight chat surface. It streams answers over SSE with read-only knowledge, wiki, and memory retrieval cited inline, and can promote a chat into a full agent run.
- `frontend/app/agent/new/page.tsx` is the task composer that starts agent runs.
- `frontend/app/session/[id]/page.tsx` is the thread view for a live or settled run. The timeline renders the canonical event log through one vendored session grammar: work-entry tool groups with folds, reasoning disclosures, collapsible context-recall receipts, live todo and plan cards, per-file unified diffs with a changed-files index, git chips, queue pills, a quiet one-line failure banner, a message-scroller tick rail, and artifact cards after the answer text. Side panes host files, an editor, a terminal, and the noVNC desktop.
- `frontend/app/lab/` is the component lab; `frontend/app/lab/session/` renders one synthetic session through the real timeline components so every event type can be reviewed on a single page.
- Skills at `/skills` include one-click import from GitHub plus an optional hourly auto-resync that keeps the catalog in sync with the org's repositories: the backend scans a repository for `SKILL.md` files over a server-side shallow clone and imports selected ones as versioned skills pinned to a commit.
- `frontend/app/learnings/page.tsx` is the human review queue for the self-improvement lane: knowledge drafts proposed from high-value runs (with the ordered, redacted procedure trace of what actually worked) and skill-revision proposals assembled from accepted drafts. Nothing is auto-published; an org admin accepts or dismisses each.
- Knowledge, wiki, memory hub, artifacts, secrets, learnings, automations, and settings all have real UI and backend paths.
- Themes: light plus three dark themes, Midnight (the default, Tokyo Night derived), Aura (violet), and Harbor (blue), selected from a theme menu and applied wholesale through semantic design tokens.
- Slack is a first-class channel: an @mention or DM starts a run, replies thread under it, inbound file attachments ride the run, GitHub links in the message bind the run's repositories (validated against the same allowlist the web composer enforces), and answers, artifacts, and approval cards flow back. Ingress enters the same durable command lane as the web UI.
- The backend exposes the API and orchestration layer at `:3201`.
- The frontend runs at `:3400` and proxies browser `/api/*` requests to the backend. The one direct backend WebSocket ingress is the run-bound Codex relay capability path.

## What Every Piece Means

| Piece | Plain-language meaning | Owner |
|---|---|---|
| Organization | The tenant boundary. Users, secrets, skills, knowledge, runs, and integrations belong to one organization. | Backend auth and database |
| Thread | One continuing conversation. Replies reuse its history, sandbox, and working directory. | Backend run service |
| Run | One agent turn inside a thread, from accepted command to terminal result. | Backend run service |
| Command | The durable instruction that starts, steers, cancels, or resumes a run. It carries an idempotency key so retries do not create duplicate work. | Backend command service |
| Step | A durable timeline item such as text, reasoning, a tool call, a question, an approval, or an artifact. | Backend event log |
| SSE stream | A one-way server stream. Thread-stream reconnects receive a fresh durable snapshot; the separate org-change stream carries live invalidations only and does not replay missed changes. | Agent client and backend |
| Canonical event | Skynet's provider-neutral representation of engine output. It lets Codex, Claude, and OpenCode render through one UI contract. | Agent harness and backend canonicalizer |
| Native frame | The original engine event retained for fidelity and debugging when the canonical shape cannot express every provider detail yet. | Engine adapter and backend |
| Engine | The coding agent runtime, such as Codex, Claude, or OpenCode. It decides what to do and emits native events. | Engine adapter |
| Engine adapter | The translator between an engine's protocol and Skynet's thread, command, and event contracts. | Backend `src/engines/` |
| Runtime path | The primary orchestration route (backend `src/engines/runtime-*`) for authoritative history, approvals, questions, child agents, patches, todos, reasoning, and usage. It is an adapter path, not a second product UI. Named by function; the vendored protocol name appears only at true wire boundaries (the provider driver and frame parsers). | Backend engine layer |
| ACP | Agent Client Protocol, used by the legacy resident Codex and Claude route when the runtime path is not selected. It has fewer authoritative lifecycle surfaces than the runtime path. | Backend ACP adapter |
| Sandbox | The isolated Linux workstation where agent commands, repositories, browser automation, desktop apps, and recordings run. | Sandbox provider |
| Sandbox provider | A vendor-specific implementation selected behind the provider-neutral sandbox contract. Daytona and Cube expose the same required process, filesystem, PTY, preview, and lifecycle boundary, then keep provider-specific behavior and tests for native capabilities. | Backend `src/sandboxes/` |
| Warm pool | Prepared sandboxes kept ready so a new run avoids most cold-start work. | Backend sandbox pool |
| Desktop | The visible XFCE and Chromium workstation shown through noVNC. Readiness requires the noVNC page, RFB, XFCE, browser CDP, and both CDP relays; Daytona can also drive it natively, while Cube uses trusted X11 controls. | Sandbox and desktop gateway |
| Gateway | A backend trust boundary that performs privileged work for a sandbox without placing long-lived provider or database credentials inside it. | Backend gateway services |
| Capability token | A short-lived signed grant bound to the organization, user, thread, run, engine, provider, scope, and expiry. | Backend gateway services |
| Provider connection | A user-owned API key or managed account identity stored by the trusted backend. Metadata is visible to the UI; reusable secrets are write-only. | Provider connection service |
| Codex subscription relay | A one-use, run-bound WebSocket capability. Codex app-server and ChatGPT OAuth stay on the trusted backend while only Codex exec-server runs in Cube or Daytona. Proven end-to-end: subscription turns, multi-turn replies (the relay continues a bound thread when the driver restarts), and the run-bound tool surface all run live. | Provider connection and runtime engine layers |
| MCP tool | A typed operation offered to an engine, such as searching knowledge, cloning a repository, controlling the desktop, or publishing an artifact. | Knowledge gateway |
| Gateway tool families | The full in-run tool surface: knowledge search, memory remember and recall, skills list and activate, automations with an approval capability gating destructive operations, GitHub pull-request and issue reads bound to the run's repository, GCS listing, web search, desktop computer-use controls with screenshots, desktop recording that publishes a real MP4 artifact, guarded ephemeral login, and artifact publishing with absolute links. Every gated refusal names its remedy (the exact skill, env var, or human approval path) so an agent can self-correct rather than fabricate. | Knowledge gateway |
| Approval lane | Human-in-the-loop authorization for destructive or outward-facing gated operations. An agent calls `approval_request`, a run-timeline card appears, an org member approves in the session view (or Slack), and the agent's `approval_poll` receives a one-shot, argument-bound capability exactly once. The capability can never be self-issued from inside a run. | Knowledge gateway and frontend |
| Learning lane | The self-improvement loop. Every completed run recalls org memory at start and captures at finish (salience-gated, evidence-enriched with the ordered tool trace). High-value runs propose knowledge drafts; accepted drafts that cluster propose skill revisions whose procedure is assembled from the real traces. Nothing publishes without a human. | Learning service and `/learnings` |
| Skill import | Scan a GitHub repository for `SKILL.md` files and import selected paths as versioned skills. Discovery runs over a server-side shallow clone with head resolution via `git ls-remote`, because the REST git-data surface is not dependable for org installations; imports are pinned to a commit and idempotent by source. | Skill catalog and GitHub service |
| Restart reconciliation | When the backend restarts under a live run, the sandbox keeps executing; a background loop re-probes the session, streams the interim provider events into the timeline with a visible heartbeat, and adopts the real result or honestly fails at a bounded deadline. | Backend run recovery |
| Connection reconcile | The durable provider-connection row heals from broker truth: a revoked row may only be reclaimed when the live account email differs from the revoked one, which proves a genuinely new login rather than a stale pre-logout snapshot. | Provider connection service |
| Skill | Versioned, reusable instructions selected semantically and activated by exact id for the current task. The turn-prefill catalog is re-ranked by prompt relevance on every unpinned turn, so the procedures that match the ask surface into the page the model sees rather than a fixed top-N by usage. | Skill catalog |
| Playbook | A skill whose content describes a repeatable end-to-end operating procedure. | Skill catalog |
| Knowledge | Organization-scoped source material the agent can search and read. It is reference data, not executable instructions. | Knowledge service |
| Wiki | A published document generated from repository or organization knowledge and later retrievable by agents. | Wiki service |
| Memory | Optional scoped facts retained across sessions for a user or team. Memory is reference material and can be disabled independently. | Memory service |
| Automation | A durable scheduled trigger that submits work through the same command lane as an interactive user. New automations start disabled. | Scheduler and command service |
| Upload | A user-provided file accepted by the backend and attached to a run after validation. | Upload service |
| Artifact | A file or result produced by an agent and published with an authenticated preview or download link. | Artifact service |
| Workpiece | A revisioned artifact editing surface with one of four canonical kinds: document, spreadsheet, presentation, or PDF. Images and videos remain previewable media artifacts, not workpieces. | Artifact service and frontend renderer |
| Outbox | Durable follow-up work written with run state, then processed safely after the transaction, such as canonicalization or Slack delivery. | Backend workers |
| Agent client | The browser-side package that reconnects to SSE, reduces events into thread state, and exposes selectors to the UI. | `packages/agent-client/` |
| Agent harness | Shared provider-neutral event, capability, session, and `ProviderDriver` lifecycle types. The production worker resolves this registry before each turn: OpenCode and selected runtime-path routes use native drivers, while legacy ACP Claude/Codex execution is declared as an EngineAdapter compatibility path. | `packages/agent-harness/` and backend engine registry |
| Conformance suite | Deterministic tests for the public agent-client and agent-harness contracts, reducer behavior, replay, and capability gating. Sandbox adapters share a provider-neutral interface but retain provider-specific tests; live provider parity is a separate environment-gated proof. | `packages/conformance/` and backend tests |

## Quick Start

Install in the app packages that have their own lockfiles, then run the two dev servers:

```bash
(cd frontend && bun install)
(cd backend && bun install)

bun run dev:backend
bun run dev:frontend
```

The common root scripts are:

```bash
bun run typecheck
bun run release:hosted
```

`bun run typecheck` covers the frontend, backend, and shared packages. `bun run release:hosted` runs the hosted release gate in `deploy/hetzner/`.
When promoting a newly built Cube runtime, set
`RELEASE_T3_CUBE_TEMPLATE_ID=tpl-...`; the gate validates the id, activates it
only inside the rollback-bound candidate environment, and restores the exact
previous environment if any preflight or parity journey fails.
The same gate installs the repository's Caddyfile only after backing up the live
configuration. It validates and reloads the candidate, and restores the prior
file on failure. The only direct backend WebSocket ingress is the one-use Codex
relay capability path; other product traffic remains behind the frontend.

## Shared Packages

| Package | Docs |
|---|---|
| `@skynet/agent-client` | [`packages/agent-client/README.md`](packages/agent-client/README.md) |
| `@skynet/agent-harness` | [`packages/agent-harness/README.md`](packages/agent-harness/README.md) |
| `@skynet/artifact-formats` | [`packages/artifact-formats/README.md`](packages/artifact-formats/README.md) |
| `@skynet/artifact-workspace` | Workpiece capability matrix shared by backend and frontend. |
| Artifact wire contract | [`packages/agent-client/ARTIFACTS.md`](packages/agent-client/ARTIFACTS.md) |

## Operational Docs

| Area | Docs |
|---|---|
| Interactive request-flow architecture | [`docs/architecture/request-flow.html`](docs/architecture/request-flow.html) |
| Backend control plane | [`backend/README.md`](backend/README.md) |
| Frontend UI | [`frontend/README.md`](frontend/README.md) |
| Optional team memory | [`memory/README.md`](memory/README.md) |
| Production DNS | [`infra/terraform/prod/README.md`](infra/terraform/prod/README.md) |

## Deployment Lanes

| Lane | What it does |
|---|---|
| Guarded release (`bun run release:hosted`) | The full certification: eight fail-closed gates covering identity, source sync, service restart, readiness (credential-mode aware), wiki generation, and per-engine parity canaries, with automatic rollback of source, env, Caddy, and services on any failure. Releases run from a clean worktree of the pushed commit, never from a working tree. |
| Provider-connection bootstrap | Deploys the full source tree and proves the account lifecycle surface without claiming runtime parity. Used to converge production onto a verified commit between certifications. |
| Atomic frontend release | Builds into an isolated dist dir, verifies BUILD_ID, swaps under a brief stop and start, checks public health and that backend and gateway PIDs never moved, and parks the previous dist as a rollback dir. |

Operational invariants: exactly one backend per database (a boot-time advisory lock enforces it; production sets `REQUIRE_SINGLE_BACKEND=1`), the sandbox gateway uses a restricted database role with explicit grants and no DDL, and secrets are write-only through the API.

## Verification Arsenal

- Backend suite (isolated throwaway database), frontend suite, shared package suites, and root typecheck across every package.
- `bun run e2e` is a mock full-stack pass including Slack and memory outbox delivery and crash-survival stages; `bun run e2e:real` exercises real sandboxes end to end; a soak marathon and a UI sweep exist for storm and browser coverage.
- Release parity canaries run real engine journeys (repo clone, computer use, desktop recording, artifact publish, automations, subagent fan-out, thread resume, model switch, web search) against a candidate before it can ship.

## Current State

- Direct chat is implemented as a no-sandbox surface with read-only retrieval.
- Agent runs are implemented as threaded sessions backed by sandboxes and streamed events; the canonical session grammar is the default rendering in the live thread view.
- Runs survive backend restarts: recovery parks and re-probes in-flight sessions, streams recovered events live, and adopts the finished result instead of failing work that actually completed.
- Production turn dispatch enters the provider registry first. Native OpenCode and selected runtime-path turns receive a concrete `ProviderDriver`; legacy ACP execution remains an explicit compatibility branch.
- User API keys are resolved inside the signed provider gateway. Managed Codex subscription turns use a separate host-owned app-server relay and never copy OAuth state into the runtime environment or a sandbox. Hosted Codex subscription execution now runs end-to-end in production: first turns, multi-turn replies, in-run tools, and the guarded-release parity case all pass live. Engine readiness stays credential-mode-aware: a subscription-only Codex release proves the connected account and native turn path, while API-key engines prove their mapped gateway provider.
- Skills and playbooks share one immutable substrate. GitHub is the source of the org's procedures: manual import plus an optional hourly resync keep the catalog current, and the prefill is relevance-ranked so the right procedure is discoverable per prompt.
- The self-improvement lane is live: salience-gated capture with structured evidence and an ordered procedure trace, human-reviewed knowledge drafts, and skill-revision proposals assembled from accepted traces. Nothing publishes without a human.
- The approval lane is live and guarded-release certified: destructive gated tools pause for a human approval card in the session (or Slack), then resume with a one-shot capability.
- Slack is bidirectional: mention-to-run, threaded replies with multi-turn continuity, inbound attachments, allowlist-validated repo binding, artifact and approval delivery back to the thread, and a per-channel ingress allowlist for scoped bring-up.
- Wiki, artifacts, secrets, learnings, automations, uploads, and memory all have real UI and backend paths.
- Ambient management updates, including Automations and Provider Connections, use one authenticated org SSE stream backed by an in-process event bus. It is a live-only invalidation channel, not event replay or distributed pub/sub; subscribed views refetch their authoritative APIs after an event arrives.
- The shared packages define the public thread-event and canonical-engine schemas; the backend event log and each live provider remain authoritative for persisted and native runtime state.

## Bounded Roadmap

- The feature-lockdown parity matrix (product features plus the reference-parity core) certifies 16 of 19 cases live on Codex through the guarded release; the remaining three are test-harness bugs (a canary-side file-ownership issue on inbound attachments, a seeded-record cleanup, and a memory-config path), not product regressions, and need harness fixes before a fully green gate.
- Two deploy-lane hardening items are the next infrastructure work: a deploy mutex so a certification rollback can never clobber a concurrent deploy, and drain-aware restarts so a backend bounce never kills an in-flight run mid-stream.
- Internal canary and diagnostic runs carry a first-class `origin` and are excluded from memory capture; filtering them out of the user's thread list is the remaining display step.
- The sandbox provider interface does not expose explicit pause, checkpoint, or snapshot operations yet.
- Turn-start latency work continues: warm-pool-claimable creation, parallelized post-sandbox preparation, and config-refresh caching are in; regional always-on topology and the remaining perceived-latency budgets are not.
- Multi-replica realtime requires durable org-event fanout before adding backend replicas.
- Artifact storage is still local to the backend node.
- Lower-severity review follow-ups are logged: down-ranking untrusted imported skill metadata in the per-turn prefill, loopback-only hardening of the operator bridge, centralizing the protected-skill name set, and caching the per-org catalog to remove the per-turn full scan.

If you need the implemented flow in detail, read [`backend/README.md`](backend/README.md) first and then [`frontend/README.md`](frontend/README.md).
