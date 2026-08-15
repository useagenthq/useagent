# Skynet backend

The backend is the control plane for Skynet. It listens on `:3201` by default and owns auth, org scoping, durable runs, sandbox orchestration, knowledge, memory, skills, playbooks, automations, artifacts, uploads, and external connectors.

## What It Owns

| Area | Main files |
|---|---|
| API bootstrap and cross-cutting middleware | [`src/index.ts`](src/index.ts), [`src/middleware/org.ts`](src/middleware/org.ts) |
| Auth and organization identity | [`src/auth.ts`](src/auth.ts), [`src/db/auth-schema.ts`](src/db/auth-schema.ts) |
| Runs, threads, SSE, finalization, recovery | [`src/runs/routes.ts`](src/runs/routes.ts), [`src/runs/finalize.ts`](src/runs/finalize.ts), [`src/runs/canonicalization-outbox.ts`](src/runs/canonicalization-outbox.ts) |
| Engines and adapters | [`src/engines/index.ts`](src/engines/index.ts), [`src/engines/*.ts`](src/engines) |
| Sandbox providers | [`src/sandboxes/provider.ts`](src/sandboxes/provider.ts), [`src/sandboxes/daytona-provider.ts`](src/sandboxes/daytona-provider.ts), [`src/sandboxes/cube-provider.ts`](src/sandboxes/cube-provider.ts) |
| Trusted capability gateways | [`src/provider-gateway/*.ts`](src/provider-gateway), [`src/knowledge/gateway/*.ts`](src/knowledge/gateway) |
| Knowledge, wiki, memory | [`src/knowledge/*.ts`](src/knowledge), [`src/memory/*.ts`](src/memory), [`src/wiki-gen/*.ts`](src/wiki-gen) |
| Skills, playbooks, automations | [`src/skills/*.ts`](src/skills), [`src/schedules/*.ts`](src/schedules) |
| Artifacts and uploads | [`src/artifacts/*.ts`](src/artifacts), [`src/uploads/*.ts`](src/uploads) |
| GitHub, Slack, email connectors | [`src/github/*.ts`](src/github), [`src/slack/*.ts`](src/slack), [`src/connectors/email/*.ts`](src/connectors/email) |

## Request Lifecycle

1. The frontend posts a run to `POST /api/runs`.
2. The backend resolves org and user server-side, then validates the request against the current org, engine policy, repos, branches, uploads, and skill selection.
3. The run and its durable command record are written atomically.
4. The selected engine adapter opens or resumes the thread sandbox and starts streaming steps, deltas, native frames, and control events.
5. The thread SSE endpoint multiplexes snapshots, runs, steps, live deltas, native frames, and canonical events to the frontend.
6. Finalization records the terminal run state and enqueues follow-up work such as memory capture, Slack delivery, and canonicalization.

## Trusted Gateway

The backend has two separate trust boundaries:

- `src/provider-gateway/*` mints and verifies signed provider capabilities, then proxies provider traffic with backend-owned credentials.
- `src/knowledge/gateway/*` exposes the trusted MCP tool surface to resident engine sessions. The sandbox gets a short-lived token, not raw database or provider credentials.

Both gateways fail closed:

- org and thread identity come from server-side token claims.
- upstream provider hosts are HTTPS-only outside local development.
- gateway tools are statically registered. The base tool families are always listed together, and only Loop login plus Slack are conditional.

## Engine Adapters

`src/engines/index.ts` is the registry for the real engine adapters.

| Adapter | Where it runs | Notes |
|---|---|---|
| `opencode` | Resident `opencode serve` inside the thread sandbox | Native resume, tool progress, child sessions, reasoning, file diffs, and commands. |
| `claude` | Resident ACP relay or CLI fallback | Honest capability surface, but weaker than OpenCode for history and child-session reconciliation. |
| `codex` | Resident ACP relay or CLI fallback | Same ACP control shape as Claude, with provider-specific model handling. |
| `daytona` | Alias for the OpenCode path | Keeps old thread rows and replies readable after the provider rename. |
| `mock` | Scripted worker path | Used for deterministic local runs and tests. |

Transport selection is controlled by `ENGINE_TRANSPORT=cli` for the legacy CLI poll-tail path. `daytona` and `claude-sdk` remain aliases for older rows.

### Capability Notes

`src/engines/capabilities.ts` is the source of truth for what the UI may show.

- Streaming text, tool progress, commands, and the sandbox terminal are available for every engine.
- File diffs, child sessions, reasoning, plans, and usage are honest only where the adapter really supports them.
- Desktop and knowledge tools are runtime resources, not pure protocol negotiation. They are only true when the session actually has them.
- The T3 orchestration path exposes the fullest capability set, including approvals and authoritative history.

## Sandbox Provider Matrix

`src/sandboxes/provider.ts` selects the provider with `SANDBOX_PROVIDER`.

| Capability | Daytona | Cube | Notes |
|---|---|---|---|
| Commands | Yes | Yes | Both providers expose the command lane. |
| Persistent command sessions | Yes | Yes | Session IDs are preserved at the provider boundary. |
| PTY | Yes | Yes | The frontend terminal uses this path. |
| File upload and download | Yes | Yes | Used for repo materialization and artifacts. |
| Preview links | Yes | Yes | Browser access is proxied through provider-issued credentials. |
| Native computer use API | Yes | No | Cube intentionally omits this surface. |
| Desktop workstation | Yes | Yes | Cube drives the workstation through the trusted gateway instead of a native computer-use API. |
| Recording | Yes | Yes | Daytona uses native recording. Cube uses the X11 and FFmpeg path. |
| Resume after timeout | Yes | Yes | Cube pauses and resumes through its provider lifecycle; Daytona resumes through its own provider lifecycle. |
| Pause, checkpoint, snapshot primitives in the shared interface | No | No | This is still a bounded roadmap item. |

The code default is Daytona unless `SANDBOX_PROVIDER=cube` is set. The deployment scripts can choose either provider at host bootstrap.

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

## Development

The backend package has its own scripts:

```bash
bun run dev
bun run start
bun run gateway
bun run test
bun run e2e
bun run e2e:real
bun run soak
```

Notes:

- `bun run dev` runs the backend in watch mode on `:3201`.
- `bun run start` runs the backend once, without watch mode.
- `bun run gateway` starts the sandbox gateway on `:3202`.
- `bun run test` prepares `skynet_test` and then runs the backend test suite.
- `bun run e2e:real` and `bun run soak` are the manual runtime checks.

### Local Environment

The important variables are:

- `DATABASE_URL` for Postgres.
- `FRONTEND_ORIGIN=http://localhost:3400` for local browser auth and CORS.
- `BETTER_AUTH_URL=http://localhost:3201` for auth redirects.
- `ENABLED_ENGINES` to opt extra engines into the backend picker.
- `SANDBOX_PROVIDER=daytona|cube` to choose the sandbox provider.
- `MEMORY_API_URL` and related memory variables to enable the optional team-memory layer.
- `GITHUB_TOKEN` or `GITHUB_APP_*` for repository access.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to enable Google sign-in.

## Deploy and Terraform

- `deploy/hetzner/deploy-release.sh` refuses tracked local changes, snapshots source, and runs the release gate.
- `deploy/hetzner/release-gate.sh` handles the hosted release workflow.
- `deploy/hetzner/configure-host.sh` provisions the host runtime, gateways, memory, and systemd wiring.
- `infra/terraform/prod/README.md` documents the Terraform scope. It only manages Cloudflare DNS.

## Current Versus Bounded

### Current

- Single-backend operation is enforced with a database lock.
- Runs, SSE, canonicalization, uploads, artifacts, memory capture, and connector delivery are all wired.
- The provider gateway and knowledge gateway are real backend services, not placeholders.
- T3 and OpenCode have the strongest adapter surface today.
- Cube and Daytona both run real sandboxes, but with different provider-specific capabilities.

### Bounded Roadmap

- Multi-replica backend operation is not supported yet.
- The sandbox provider interface still lacks explicit pause, checkpoint, and snapshot operations.
- Legacy ACP restart reconciliation is weaker than the OpenCode and T3 paths.
- Artifact storage is still local to the backend node.
- Richer artifact renderers and shared object storage remain future work.

## See Also

- [`../README.md`](../README.md) for the repo map.
- [`../frontend/README.md`](../frontend/README.md) for the UI layer.
- [`../packages/agent-client/README.md`](../packages/agent-client/README.md) for the browser/runtime client contract.
- [`../packages/agent-harness/README.md`](../packages/agent-harness/README.md) for the canonical engine contract.
- [`../memory/README.md`](../memory/README.md) for the optional memory service.
