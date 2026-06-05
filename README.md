# useAgent

**The open, self-hostable control plane for coding agents.** Run Codex, Claude Code, and OpenCode as durable, threaded sessions in isolated Linux sandboxes - one event contract, one UI, your infrastructure.

useAgent is a multi-package repository with one product UI, one backend control plane, and shared TypeScript packages that define the cross-package contracts. Postgres is the source of truth: every run is an event-sourced timeline that survives restarts, renders through one session grammar regardless of which engine produced it, and stays inspectable after the fact.

## Features

- **Choice of agent.** Codex (API key or ChatGPT subscription), Claude Code, and OpenCode run behind one provider-neutral canonical event contract - switch engines per run, render through one session UI. Native frames are retained alongside canonical events for fidelity and debugging.
- **Durable runs.** Event-sourced on Postgres; runs survive backend restarts. Recovery re-probes in-flight sessions, streams recovered events live with a visible heartbeat, and adopts the finished result instead of failing work that actually completed.
- **Real sandboxes.** Each agent-run thread gets an isolated Linux workstation: terminal, repositories, browser automation, and a visible XFCE desktop over noVNC with recording to real MP4 artifacts. Warm pools cut cold-start work; Daytona and Cube sit behind one provider-neutral sandbox contract.
- **A trusted gateway, not credentials in the sandbox.** The sandbox holds only short-lived signed capability tokens. Knowledge search, memory, skills, GitHub reads, web search, desktop control, and artifact publishing are typed MCP tools served by the backend; every gated refusal names its remedy so an agent can self-correct instead of fabricate.
- **Human-in-the-loop approvals.** Destructive tools pause on an approval card in the session (or Slack) and resume with a one-shot, argument-bound capability that can never be self-issued from inside a run.
- **Skills and playbooks from GitHub.** Import `SKILL.md` files from your repositories as versioned skills pinned to a commit, optionally resync on a configured interval, and relevance-rank them into every turn so the right procedure surfaces per prompt.
- **Knowledge, wiki, and memory.** Org-scoped retrieval with inline citations, generated wikis, and optional scoped team memory. A human-reviewed learning lane proposes knowledge drafts from high-value runs and skill revisions from accepted drafts - nothing publishes without a person.
- **Slack as a first-class channel.** Mention-to-run, threaded replies with multi-turn continuity, inbound attachments, allowlist-validated repo binding, and answers, artifacts, and approval cards back in the thread - through the same durable command lane as the web UI.
- **Native artifacts.** DOCX, XLSX, PPTX, and PDF workpieces with revisioned editing surfaces and native renderers; images and videos remain previewable media artifacts.
- **Guarded releases.** A fail-closed release gate runs real engine journeys (repo clone, computer use, desktop recording, artifact publish, subagent fan-out, thread resume) against a candidate and rolls back source, env, Caddy, and services on any failure; a separate rollback-safe fast lane handles ordinary product deploys.

## Quick Start

Requires [bun](https://bun.sh) and Postgres.

```bash
for workspace in \
  packages/agent-harness packages/artifact-workspace \
  packages/agent-client packages/artifact-formats packages/conformance \
  backend frontend; do
  (cd "$workspace" && bun install)
done

bun run dev:backend    # API + orchestration on :3201
bun run dev:frontend   # UI on :3400 (proxies /api/* to the backend)
```

`bun run typecheck` covers the frontend, backend, and every shared package. `bun run deploy:hosted` is the normal rollback-safe deployment lane; `bun run release:hosted` runs the exhaustive hosted certification gate in `deploy/hetzner/`.

## Run Your Own Instance

[`infra/terraform/hetzner/`](infra/terraform/hetzner/README.md) provisions a complete host (server, firewall, PostgreSQL 16 + pgvector, bun, Node, Docker, Caddy) with one `terraform apply`, and `deploy-app.sh` brings up the **core stack** (backend + frontend + Caddy) with a single command:

```bash
export HCLOUD_TOKEN=...            # never committed
cd infra/terraform/hetzner
terraform init && terraform apply  # provision the host + dependencies
SERVER_IP=$(terraform output -raw server_ip) PG_PASSWORD=... OPENROUTER_API_KEY=... \
  ./deploy-app.sh /path/to/this/repo
```

That yields a signed-in web UI and model-backed chat. Full engine runs, team memory, and the desktop need the additional secrets and a baked sandbox template documented in the [Terraform README](infra/terraform/hetzner/README.md#scope-core-vs-full). The token is read from `HCLOUD_TOKEN` only; state and tfvars are gitignored.

## Repo Map

| Path | What it owns |
|---|---|
| `frontend/` | Next.js UI on the BoardUI design system (vendored base primitives, application blocks, and semantic tokens). Chat, agent sessions, skills, playbooks, wiki, artifacts, secrets, learnings review, automations, and settings. |
| `backend/` | Hono + Postgres control plane. Auth, org scoping, runs, sandboxes, engines, knowledge, memory, skills, automations, artifacts, uploads, and connectors. |
| `docs-site/` | The product documentation site (Blume/Astro): getting started, concepts, architecture with SVG diagrams, product, platform, API, operations, and channels. `bun run dev` / `bun run build`. |
| `deploy/hetzner/` | Hosted release tooling: the guarded release gate, the fast rollback-safe deploy lane, provider-connection bootstrap, and the atomic frontend release. |
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
- `frontend/app/lab/` is the component lab: the BoardUI parts bin (native primitives with their variants), the full vendored agent component set rendered live, the AI kit, and the session timeline grammar; `frontend/app/lab/session/` renders one synthetic session through the real timeline components so every event type can be reviewed on a single page.
- Skills at `/skills` include one-click import from GitHub plus an optional hourly auto-resync that keeps the catalog in sync with the org's repositories: the backend scans a repository for `SKILL.md` files over a server-side shallow clone and imports selected ones as versioned skills pinned to a commit.
- `frontend/app/learnings/page.tsx` is the human review queue for the self-improvement lane: knowledge drafts proposed from high-value runs (with the ordered, redacted procedure trace of what actually worked) and skill-revision proposals assembled from accepted drafts. Nothing is auto-published; an org admin accepts or dismisses each.
- Knowledge, wiki, memory hub, artifacts, secrets, learnings, automations, and settings all have real UI and backend paths.
- Design system: BoardUI (licensed, vendored source via its CLI) - base primitives in `frontend/components/base/`, application blocks in `frontend/components/application/`, and the semantic token layer in `frontend/styles/theme.css` + per-theme override blocks in `frontend/app/globals.css`. The legacy AlignUI library survives only as the sanctioned dialog/overlay layer (`frontend/components/ui/README.md`).
- Themes: nine, dark-first - Midnight (default), Light, Aura (violet), Harbor (blue), Slate (blue-gray), Dark Green and Light Green (phosphor), Dark Red and Light Red (sakura) - selected from the theme menu and applied wholesale through semantic tokens; each theme overrides the full BoardUI slot list so every surface follows.
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
| Canonical event | useAgent's provider-neutral representation of engine output. It lets Codex, Claude, and OpenCode render through one UI contract. | Agent harness and backend canonicalizer |
| Native frame | The original engine event retained for fidelity and debugging when the canonical shape cannot express every provider detail yet. | Engine adapter and backend |
| Engine | The coding agent runtime, such as Codex, Claude, or OpenCode. It decides what to do and emits native events. | Engine adapter |
| Engine adapter | The translator between an engine's protocol and useAgent's thread, command, and event contracts. | Backend `src/engines/` |
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

## Shared Packages

| Package | Docs |
|---|---|
| `@useagent/agent-client` | [`packages/agent-client/README.md`](packages/agent-client/README.md) |
| `@useagent/agent-harness` | [`packages/agent-harness/README.md`](packages/agent-harness/README.md) |
| `@useagent/artifact-formats` | [`packages/artifact-formats/README.md`](packages/artifact-formats/README.md) |
| `@useagent/artifact-workspace` | Workpiece capability matrix shared by backend and frontend. |
| Artifact wire contract | [`packages/agent-client/ARTIFACTS.md`](packages/agent-client/ARTIFACTS.md) |

## Deployment Lanes

| Lane | What it does |
|---|---|
| Normal deploy (`bun run deploy:hosted`) | Exact clean commit, host mutex, admission drain, source snapshot, one dependency/build/restart pass, public health smoke, and automatic source rollback. Designed for ordinary product releases. |
| Guarded release (`bun run release:hosted`) | Exhaustive certification: identity, source sync, readiness, workpieces, provider parity, and hard journeys with automatic rollback. Run for release candidates and scheduled certification, not every UI patch. |
| Provider-connection bootstrap | Deploys the full source tree and proves the account lifecycle surface without claiming runtime parity. Used to converge production onto a verified commit between certifications. |
| Atomic frontend release | Builds into an isolated dist dir, verifies BUILD_ID, swaps under a brief stop and start, checks public health and that backend and gateway PIDs never moved, and parks the previous dist as a rollback dir. |

The normal lane accepts only backward-compatible migrations explicitly marked `-- fast-deploy: expansion-safe`; destructive schema changes require the guarded release lane. Both lanes require an authenticated release identity.

Database migrations are forward-only in both lanes. Schema changes must follow
an expand, migrate, contract sequence; restoring source and services does not
reverse an applied migration.

When promoting a newly built Cube runtime, set `RELEASE_T3_CUBE_TEMPLATE_ID=tpl-...`; the gate validates the id, activates it only inside the rollback-bound candidate environment, and restores the exact previous environment if any preflight or parity journey fails. The same gate installs the repository's Caddyfile only after backing up the live configuration, validates and reloads the candidate, and restores the prior file on failure.

Operational invariants: exactly one backend per database (a boot-time advisory lock enforces it; production sets `REQUIRE_SINGLE_BACKEND=1`), the sandbox gateway uses a restricted database role with explicit grants and no DDL, and secrets are write-only through the API.

## Verification Arsenal

- Backend suite (isolated throwaway database), frontend suite, shared package suites, and root typecheck across every package.
- `bun run e2e` is a mock full-stack pass including Slack and memory outbox delivery and crash-survival stages; `bun run e2e:real` exercises real sandboxes end to end; a soak marathon and a UI sweep exist for storm and browser coverage.
- Release certification runs real engine journeys (repo clone, computer use, desktop recording, artifact publish, automations, subagent fan-out, thread resume, model switch, web search). Ordinary deployments use the separate fast lane described above.

## Documentation

| Area | Docs |
|---|---|
| Product docs site (concepts, architecture + SVG diagrams, API, operations) | [`docs-site/`](docs-site/README.md) |
| Interactive request-flow architecture | [`docs/architecture/request-flow.html`](docs/architecture/request-flow.html) |
| Backend control plane | [`backend/README.md`](backend/README.md) |
| Frontend UI | [`frontend/README.md`](frontend/README.md) |
| Optional team memory | [`memory/README.md`](memory/README.md) |
| Production DNS | [`infra/terraform/prod/README.md`](infra/terraform/prod/README.md) |

If you need the implemented flow in detail, read [`backend/README.md`](backend/README.md) first and then [`frontend/README.md`](frontend/README.md).

## License

useAgent is open source under the [GNU AGPL v3.0](LICENSE) (AGPL-3.0-only).
Third-party components and their licenses are listed in [NOTICE](NOTICE);
vendored and ported files carry per-file attribution headers.
