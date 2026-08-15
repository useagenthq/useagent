# skynet

Skynet is a multi-package repository for the Loop agent platform. The repo has one product UI, one backend control plane, and shared TypeScript packages that define the cross-package contracts.

## Repo Map

| Path | What it owns |
|---|---|
| `frontend/` | Next.js UI. Chat, agent sessions, skills, playbooks, wiki, artifacts, secrets, review, and settings. |
| `backend/` | Hono + Postgres control plane. Auth, org scoping, runs, sandboxes, engines, knowledge, memory, skills, schedules, artifacts, uploads, and connectors. |
| `packages/agent-client/` | Runtime-neutral client for thread events, SSE reconnect, reducers, selectors, and typed API helpers. |
| `packages/agent-harness/` | Provider-neutral canonical event and control contract for engine adapters. |
| `packages/conformance/` | Framework-free contract tests for the shared packages. |
| `memory/` | Optional team-memory service docs and bring-up notes. |
| `infra/terraform/prod/` | Terraform for Cloudflare DNS only. |

## Product Surface

- `frontend/app/page.tsx` is the lightweight chat surface.
- `frontend/app/agent/new/page.tsx` is the task composer that starts agent runs.
- `frontend/app/session/[id]/page.tsx` is the thread view for a live or settled run.
- The backend exposes the API and orchestration layer at `:3201`.
- The frontend runs at `:3400` and proxies browser `/api/*` requests to the backend.

## What Every Piece Means

| Piece | Plain-language meaning | Owner |
|---|---|---|
| Organization | The tenant boundary. Users, secrets, skills, knowledge, runs, and integrations belong to one organization. | Backend auth and database |
| Thread | One continuing conversation. Replies reuse its history, sandbox, and working directory. | Backend run service |
| Run | One agent turn inside a thread, from accepted command to terminal result. | Backend run service |
| Command | The durable instruction that starts, steers, cancels, or resumes a run. It carries an idempotency key so retries do not create duplicate work. | Backend command service |
| Step | A durable timeline item such as text, reasoning, a tool call, a question, an approval, or an artifact. | Backend event log |
| SSE stream | The one-way live connection that sends thread snapshots and new events to the browser. Reconnects replay from durable state. | Agent client and backend |
| Canonical event | Skynet's provider-neutral representation of engine output. It lets Codex, Claude, and OpenCode render through one UI contract. | Agent harness and backend canonicalizer |
| Native frame | The original engine event retained for fidelity and debugging when the canonical shape cannot express every provider detail yet. | Engine adapter and backend |
| Engine | The coding agent runtime, such as Codex, Claude, or OpenCode. It decides what to do and emits native events. | Engine adapter |
| Engine adapter | The translator between an engine's protocol and Skynet's thread, command, and event contracts. | Backend `src/engines/` |
| T3 path | The richer orchestration path adapted from T3 Code patterns for authoritative history, approvals, questions, child agents, patches, todos, reasoning, and usage. It is an adapter path, not a second product UI. | Backend engine layer |
| ACP | Agent Client Protocol, used as a compatibility transport for some resident Codex and Claude sessions. It has fewer authoritative lifecycle surfaces than the T3 path. | Backend ACP adapter |
| Sandbox | The isolated Linux workstation where agent commands, repositories, browser automation, desktop apps, and recordings run. | Sandbox provider |
| Sandbox provider | The vendor-specific implementation behind the common sandbox contract. Daytona and Cube are interchangeable at this boundary, while their native capabilities differ. | Backend `src/sandboxes/` |
| Warm pool | Prepared sandboxes kept ready so a new run avoids most cold-start work. | Backend sandbox pool |
| Desktop | The visible XFCE and Chromium workstation shown through noVNC. Daytona can drive it natively; Cube uses trusted X11 controls. | Sandbox and desktop gateway |
| Gateway | A backend trust boundary that performs privileged work for a sandbox without placing long-lived provider or database credentials inside it. | Backend gateway services |
| Capability token | A short-lived signed grant bound to the organization, user, thread, run, engine, provider, scope, and expiry. | Backend gateway services |
| MCP tool | A typed operation offered to an engine, such as searching knowledge, cloning a repository, controlling the desktop, or publishing an artifact. | Knowledge gateway |
| Skill | Versioned, reusable instructions selected semantically and activated by exact id for the current task. | Skill catalog |
| Playbook | A skill whose content describes a repeatable end-to-end operating procedure. | Skill catalog |
| Knowledge | Organization-scoped source material the agent can search and read. It is reference data, not executable instructions. | Knowledge service |
| Wiki | A published document generated from repository or organization knowledge and later retrievable by agents. | Wiki service |
| Memory | Optional scoped facts retained across sessions for a user or team. Memory is reference material and can be disabled independently. | Memory service |
| Automation | A durable scheduled trigger that submits work through the same command lane as an interactive user. New automations start disabled. | Scheduler and command service |
| Upload | A user-provided file accepted by the backend and attached to a run after validation. | Upload service |
| Artifact | A file or result produced by an agent and published with an authenticated preview or download link. | Artifact service |
| Workpiece | An artifact with a richer product preview, such as a document, spreadsheet, image, video, or generated app. | Artifact service and frontend renderer |
| Outbox | Durable follow-up work written with run state, then processed safely after the transaction, such as canonicalization or Slack delivery. | Backend workers |
| Agent client | The browser-side package that reconnects to SSE, reduces events into thread state, and exposes selectors to the UI. | `packages/agent-client/` |
| Agent harness | The shared provider-neutral event and control types every engine adapter must satisfy. | `packages/agent-harness/` |
| Conformance suite | Contract tests that prove shared packages and provider adapters behave the same at their public boundaries. | `packages/conformance/` and backend tests |

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

## Shared Packages

| Package | Docs |
|---|---|
| `@skynet/agent-client` | [`packages/agent-client/README.md`](packages/agent-client/README.md) |
| `@skynet/agent-harness` | [`packages/agent-harness/README.md`](packages/agent-harness/README.md) |
| Artifact wire contract | [`packages/agent-client/ARTIFACTS.md`](packages/agent-client/ARTIFACTS.md) |

## Operational Docs

| Area | Docs |
|---|---|
| Backend control plane | [`backend/README.md`](backend/README.md) |
| Frontend UI | [`frontend/README.md`](frontend/README.md) |
| Optional team memory | [`memory/README.md`](memory/README.md) |
| Production DNS | [`infra/terraform/prod/README.md`](infra/terraform/prod/README.md) |

## Current State

- Direct chat is implemented as a no-sandbox surface with read-only retrieval.
- Agent runs are implemented as threaded sessions backed by sandboxes and streamed events.
- Skills and playbooks share one immutable substrate.
- Wiki, artifacts, secrets, review, schedules, uploads, and memory all have real UI and backend paths.
- The shared packages are the source of truth for thread events and canonical engine output.

## Bounded Roadmap

- Canonical timeline rendering in the frontend is still opt-in.
- The sandbox provider interface does not expose explicit pause, checkpoint, or snapshot operations yet.
- Legacy ACP restart reconciliation and authoritative child/history surfaces are still weaker than the OpenCode and T3 paths.
- Artifact storage is still local to the backend node.

If you need the implemented flow in detail, read [`backend/README.md`](backend/README.md) first and then [`frontend/README.md`](frontend/README.md).
