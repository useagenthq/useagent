# Skynet Agent Platform — Master Architecture and Delivery Prompt

> **SCOPE DECISION (user, 2026-08-06): adopted as the delivery north star with the
> enterprise layer explicitly OUT OF SCOPE for now.** Skip until there is a real
> second tenant / enterprise customer: SSO, SCIM, domain verification, regional
> residency, legal hold, billing/usage metering, support impersonation, and
> multi-replica leases/fencing (single backend replica is assumed; add fencing
> only when a second replica exists). Everything else — the locked Stage-1
> resident-OpenCode topology, lossless native capture, REUSE/PROJECT/BUILD
> gating, native-ID projections, phases 0–5 — is active guidance. Do not build
> the gated items "while you're in there".

## Mission

You are responsible for evolving Skynet from a visually plausible agent chat application into a stable, fast, secure, multi-tenant agent platform for engineering teams and organizations.

This is primarily a business-to-business SaaS product. It may also support personal or single-team installations, but the canonical design must assume:

- Multiple organizations and workspaces
- Multiple teams, projects, repositories, and users per organization
- Role-based and resource-level authorization
- Shared sessions and multiplayer collaboration
- Concurrent agents and child agents
- Usage metering, quotas, retention, auditability, and administrative controls
- Web, Slack, API, CLI, schedules, webhooks, and future channels
- Replaceable agent harnesses and replaceable sandbox providers
- Long-running work that survives browsers, processes, deployments, and sandbox failures

The system must be fast on the happy path and correct on failure paths. Optimize for the smallest architecture that enforces the required invariants. Do not add infrastructure merely because it is fashionable.

## Read Before Acting

Inspect these sources before proposing or changing code:

1. Current application:
   `~/Documents/acme/new-skynet`
2. Experimental React port:
   `~/Documents/acme/skynet-react-port`
3. OpenCode and React audit:
   `~/Documents/acme/OPENCODE_REACT_UI_DEEP_DIVE.md`
4. React-port handoff and struggle log:
   `~/Documents/acme/skynet-react-port/react_port.md`
5. The exact OpenCode source version used by the backend. The current adapter pins
   `opencode-ai@1.18.7`; inspect [tag `v1.18.7`](https://github.com/anomalyco/opencode/tree/v1.18.7), not only current `main`.
6. reference bot's current official repository and architecture documentation as a useful
   gateway-around-native-harness reference, while respecting its local/single-owner
   limitations: <https://github.com/kirodotdev/reference bot>.
7. UX evidence screenshots, including the OpenCode fanout view and reference parent/child
   session, Progress, Desktop, and Agents views on the Desktop. Treat screenshots as
   product-behavior evidence, not proof of proprietary backend architecture.
   - `~/Desktop/Screenshot 2026-08-05 at 6.43.57 PM.png`
   - `~/Desktop/Screenshot 2026-08-05 at 6.44.15 PM.png`
   - `~/Desktop/Screenshot 2026-08-05 at 6.44.19 PM.png`
   - `~/Desktop/Screenshot 2026-08-05 at 6.44.27 PM.png`
   - `~/Desktop/Screenshot 2026-08-05 at 6.52.33 PM.png`
8. Repository-local `AGENTS.md` files and relevant package documentation
9. Current git status, branches, migrations, tests, and uncommitted files in both worktrees

Treat uncommitted changes as user-owned. Never reset, overwrite, discard, or reformat unrelated work.

Before implementation, distinguish all important claims as:

- `CONFIRMED FROM CURRENT CODE`
- `CONFIRMED FROM OFFICIAL PROVIDER DOCUMENTATION`
- `ARCHITECTURAL INFERENCE`
- `UNKNOWN — REQUIRES SPIKE OR MEASUREMENT`

## Product Definition

Skynet is not merely a React wrapper around OpenCode. It is the trusted product system of record and control plane for organizational agent work. In Stage 1, OpenCode remains authoritative for its provider-native active session internals; Skynet durably mirrors the history and state the product needs and never pretends a lossy projection is the native runtime.

Current defaults:

- Web client: React
- Primary harness: OpenCode
- Sandbox provider: Daytona
- Additional channel: Slack

Future targets may include:

- Harnesses: Claude Code, OpenAI Codex, OpenCode, custom Agents SDK loops, and other agents
- Sandboxes: Daytona, Docker, Kubernetes, Cloudflare, Modal, E2B, Vercel, Firecracker, and other VM/container services
- Channels: React web, Slack, API, CLI, GitHub, Linear, Jira, Microsoft Teams, Discord, schedules, and webhooks
- Capabilities: knowledgebase, repository documentation/wiki, team memory, playbooks, skills, automations, approvals, artifacts, browser/desktop, terminal, and multi-agent orchestration

Changing a harness must not require rebuilding the React product shell, common event protocol, or team features; an isolated provider adapter and provider-specific part renderers are expected. Changing a sandbox provider must not replace Skynet identity, history projection, or team records. Adding Slack or another channel must not create another source of product truth.

## Non-Negotiable Architecture

### Locked Stage-1 decision

Do not externalize or reimplement the OpenCode agent loop in Stage 1.

OpenCode already is the native harness. It runs inside the thread's Daytona sandbox and owns the provider-native model/tool loop, agent selection, `task` tool, subagent creation, foreground/background child execution, child result injection, native messages/parts, tool lifecycle, compaction, and session continuation.

Skynet runs outside the sandbox as the product control plane. It does not become a second agent harness. It accepts tenant-scoped product commands, provisions or reconnects the sandbox, talks to the resident OpenCode server, durably mirrors native state needed by the product, enforces organization policy, and projects that state to React, Slack, schedules, and APIs.

The Stage-1 topology is:

```text
React / Slack / API / CLI / schedules / webhooks
                         |
                         v
                Skynet trusted control plane
                - identity and authorization
                - idempotent product commands
                - OpenCode/sandbox identity mappings
                - durable native-event and snapshot mirror
                - connector, schedule, approval, and policy state
                - knowledge and memory policy
                - audit and observability
                - replayable client events and connector outbox
                         |
                         | resident-harness adapter over REST/SSE
                         v
                  Daytona thread sandbox
                - repository and filesystem
                - OpenCode server and native session
                - OpenCode-owned model/tool/agent loop
                - shell, git, builds, tests, browser, desktop
```

The `HarnessAdapter` in Stage 1 is a typed client/facade around the resident OpenCode server. Its existence does not mean Skynet owns or runs the loop. The `SandboxProvider` provisions and reconnects Daytona; it is not a mandate to replace OpenCode's native tools with remote Skynet tools.

Nothing produced by the model may execute directly on the trusted control-plane host. Model-generated commands, code, builds, tests, package installation, file operations, and development servers execute inside Daytona through OpenCode.

Do not keep the following solely inside a sandbox:

- Canonical session history
- Retry and recovery authority
- Organization permissions
- Approval policy or state
- Audit history
- Primary model credentials
- Organization-wide connector credentials
- Sibling-agent routing credentials
- Durable schedules or automation state

The sandbox may sleep, crash, become corrupt, or be replaced without destroying Skynet's product record. Stage 1 does **not** promise byte-identical continuation of provider-private state after permanent sandbox loss. It promises durable history/projection, explicit interruption/reconciliation, and a fresh-session handoff when native resume is impossible.

Externalizing the loop and exposing the sandbox only as remote tools is a possible later architecture, not current scope. Do it only after a measured spike proves a concrete security, durability, or provider-portability benefit worth losing or recreating native OpenCode behavior.

## Current Root Problem

The current product already has the correct basic integration direction:

- `backend/src/engines/opencode-server.ts` runs a resident OpenCode server, subscribes to `/event`, polls/reconciles REST history, registers child sessions, and maps text/tool/subtask parts.
- `backend/src/runs/routes.ts` replays persisted steps and streams `step`, `delta`, and `done` events.
- `frontend/components/chat/use-run-stream.ts` upserts step updates by index.
- The existing React session surface already renders conversation, tool/file rows, Agents rail, editor, terminal, desktop, and composer.

Do not throw these away. The problem is the information boundary between OpenCode and this UI. It currently compresses OpenCode's native model into approximately:

```text
thread
  run
    step: command | file | task | done
    summary
    liveText
```

This loses information needed for a reliable agent UI and platform:

- Native message and part IDs
- Parent and causal relationships
- Part lifecycle and revisions
- Reasoning
- Tool inputs, outputs, progress, and failure states
- Permissions and approvals
- Questions
- Todos and plans
- Errors and retry state
- File patches and artifacts
- Compaction
- Child sessions and grandchildren
- Knowledge citations
- Connector provenance
- Durable cursors

This is why the current `AgentsRail` must guess that every `↳` activity belongs to the most recently spawned card, and why native child sessions cannot be opened reliably. It is also why tool IDs/status, child text, approvals, questions, todos, diffs, errors, and provider extensions disappear.

Repair this without a flag-day platform rewrite:

1. Preserve the full provider event/part before translating it.
2. Retain stable native session/message/part/tool/call/parent IDs.
3. Continue producing the current `ApiStep`/marker projection for existing UI compatibility.
4. Incrementally replace heuristics with ID-backed projections.
5. Add a new durable product object only when a marker cannot safely provide the behavior.

Do not add more visual cards that are backed only by guessed labels or display order. Do add markers backed by real OpenCode IDs and lifecycle.

## Canonical Ownership

### Skynet owns

- Organizations, workspaces, teams, projects, and memberships
- Stable Skynet thread/session identity and mappings to native OpenCode IDs
- External product commands and idempotency
- A durable mirror/projection of native history required for loading, reconnect, search, audit, Slack, and sandbox-loss UX
- Preservation of native events, messages, parts, tools, and child relationships without lossy rewriting
- Product-level approvals, questions, blockers, cancellation intent, retries, and escalation policy
- Skynet event ordering, schemas, cursors, and connector outbox
- Authorization, policy evaluation, and audit records
- Knowledge retrieval and team-memory policy
- Playbook and automation execution policy
- Connector mappings and delivery
- Retention, deletion, export, and legal-hold policy
- Provider reconciliation and operational recovery

### Harness adapters own

- Provider-native session creation, continuation, and interaction
- Calling/subscribing/snapshotting the resident or hosted harness
- Lossless capture of provider events before optional normalization
- Provider snapshot/history retrieval
- Provider-specific cancellation, permission, and question responses
- Capability detection and mapping native events into Skynet envelopes/markers

### OpenCode owns in Stage 1

- Primary agent and subagent execution semantics
- The `task` tool and native fanout orchestration
- Child-session creation with `parentID`
- Foreground/background child lifecycle and result injection
- Native agent configuration, prompts, models, permissions, skills, and MCP behavior
- Native messages and parts, including text, reasoning, tool, file, subtask, compaction, step, patch, and snapshot parts
- Native tool states: pending, running, completed, and error
- Native todos, diffs, fork/revert/unrevert, summarize/compaction, abort, session status, and PTY behavior where used

Skynet observes, scopes, persists, reconciles, and renders these. It does not recreate them.

### Sandbox providers own

- Isolated filesystem and process execution
- Repository workspace
- Package installation and builds
- Terminal/PTY connections
- Development servers and preview ports
- Desktop/browser availability where supported
- Sandbox lifecycle, resource isolation, and snapshots

### Clients and connectors own

- Presentation and input collection
- External message identity and formatting
- Transport-local retry within defined rules

Clients do not own execution truth.

## OpenCode Capability Reuse Matrix

This matrix is a scope gate. Before implementing anything named here, confirm whether the pinned OpenCode version already provides it.

| Capability | OpenCode v1.18.7 already provides | Skynet Stage-1 action | Do not build |
|---|---|---|---|
| Primary agent loop | Model/tool loop and native session | Start/resume and observe it | Another loop in the backend |
| Fanout/subagents | `task` tool, child sessions, `parentID`, per-child agent/model/permissions, `task_id` resume, configurable depth | Mirror child IDs/lineage/status and render cards | A parallel Skynet subagent scheduler for ordinary native fanout |
| Background children | Experimental background tasks with completion injection | Feature-detect and expose honestly; fall back to foreground | Polling/sleep loops that duplicate OpenCode's background job |
| Session history | Native messages plus typed parts, persisted by OpenCode | Snapshot/mirror for product durability and fast reads | Reconstructed prompt-summary history as the primary transcript |
| Streaming | `/event`, `message.part.updated`, deltas, session events | Proxy/ingest with `?directory=<workdir>` (un-scoped /event attaches to the default workspace instance's bus and hears nothing — proven 2026-08-06; earlier "proxy buffers SSE" diagnosis was wrong); reconcile from REST as truth regardless | A second token-stream protocol between adapter and OpenCode |
| Tool lifecycle | Stable parts/call IDs and pending/running/completed/error state | Preserve IDs/full payload; project existing tool rows | Label-only guessed lifecycle |
| Child discovery | `GET /session/:id/children` and session create/update events | Hydrate recursive native session graph | Inferring ownership from order or `↳` prefixes |
| Status | `GET /session/status` plus status/error events | Project into Skynet transport/execution status | Deriving child status from parent run status |
| Todos/plans | `GET /session/:id/todo` and todo events | Add marker/panel using native IDs/state | A new planner engine |
| Diffs/changes | `GET /session/:id/diff`, patch/snapshot/file parts | Feed current editor/review surfaces; persist large data as artifacts only if needed | Recomputing diffs from labels |
| Permissions | Permission asked/replied events and reply APIs | Enforce tenant/product policy outside; render/route decisions back | Auto-approve as the only production behavior or a second permission protocol |
| Questions | Question asked/replied/rejected events and APIs | Render blocking interaction and route answer | Converting questions into ordinary chat text |
| Cancel | Session abort | Issue through adapter and record product intent/result | Killing random wrapper processes as normal cancellation |
| Fork/revert/compaction | Native fork, revert/unrevert, summarize, compaction parts/events | Expose when product needs them; mirror result | Reimplementing native transcript mutation |
| PTY | Native PTY APIs exist; Daytona shell/desktop also exist | Choose one scoped product integration and reuse current panes | Multiple competing terminal implementations |
| Commands/agents/config/MCP | Native endpoints/configuration | Discover/capability-gate and project into current composer/settings | Hardcoded fake command or agent catalogs |

The matrix does not mean every native feature is automatically SaaS-safe. Native pending permissions/questions are process-local in the audited OpenCode implementation, so Skynet must durably record product intent and reconciliation state if they must survive a provider restart. That is a durability wrapper around OpenCode, not a reimplementation of its agent behavior.

### What is actually new Skynet product work

Build only the layer OpenCode does not provide:

- Organization/workspace/project identity, membership, RBAC, policy, audit, quotas, billing, and retention
- Slack/team/API installation identity and external-conversation mapping
- Durable external command acceptance/idempotency and connector outbox
- Durable provider-ID mapping, raw event capture, snapshots, replay, and reconciliation
- Cross-session/team knowledge, memory, wiki, playbooks, automations, and schedules
- Product-level approval policy and cross-surface resolution
- First-class artifacts only where durable download/preview/share/retention is required
- Cross-provider portability and explicit handoff, not fake native resume
- Fleet operations, leases/fencing where multiple backend replicas can race, health, and observability

### Reference-product conclusions

- **OpenCode is the implementation source of truth for native capability.** Its web UI feels mature largely because it renders its own message/part/session model directly. Copy or port proven renderer/state/markdown behavior where the MIT license permits, with attribution; do not copy its whole product shell or Solid-specific global chrome into React.
- **reference bot validates a gateway around a native harness.** Its gateway owns surfaces, session routing, memory, schedules, approvals, apps, security, and persistent history around `kiro-cli`/ACP. It does not prove team SaaS architecture: current state is local/on-disk, there is no independent account system, and Slack/multi-user behavior has explicit owner limitations. Copy the boundary pattern, not its single-host assumptions.
- **reference is a UX benchmark, not an architecture spec.** The observed product exposes parent/child breadcrumbs, exact delegated prompts, individually named child sessions, per-child status, an Agents rail, Progress/knowledge inspection, live Desktop, and guidance while work continues. Build these behaviors from OpenCode's native sessions plus Skynet product state. Do not assert the reference tool's private harness placement, actor model, or storage internals without primary evidence.
- **The actor-model article is architectural guidance, not a mandate for immediate rewrite.** Skynet needs durable commands, scheduling, outbox, and per-session ownership outside the sandbox, but Stage 1 can wrap resident OpenCode. Introduce Rivet/agentOS or another actor runtime only after a spike demonstrates operational value over leased workers and the current provider adapter.

## Confirmed Current Codebase Inventory

Revalidate line numbers before changing code, but begin from this evidence instead of rediscovering the architecture:

| Area | Already real and reusable | Confirmed limitation / next boundary |
|---|---|---|
| OpenCode runtime | Resident `opencode serve`, native session ID persisted, same thread sandbox reused, pre-prompt SSE, REST reconciliation, child discovery (`backend/src/engines/opencode-server.ts`) | Adapter translates only a narrow set into generic steps and drops native identity/types. Current uncommitted serialized-part/mid-turn-poller edits are user-owned and must be preserved. |
| Engine contract | `EngineAdapter`, text deltas, append/update step callbacks (`backend/src/engines/types.ts`) | Every provider is forced into `EmitStep`; add a lossless native event/snapshot lane rather than another adapter. |
| Durable records | Runs persist `threadId`, `engineSessionId`, and `sandboxId`; steps replay after reconnect (`backend/src/db/schema.ts`, `backend/src/runs/repo.ts`) | Only `command | file | task | done` with label/chip/code JSON; no stable native message/part/tool/child identity. |
| Live delivery | Authenticated SSE replays steps, sends deltas, supports same-index enrichment, heartbeat/no-buffer headers (`backend/src/runs/routes.ts`) | Only `step`, `delta`, `done`; deltas are transient and there is no general cursor/versioned native event stream. |
| Worker/runtime | Same-thread turns are serialized and adapters have timeouts (`backend/src/worker.ts`) | Ownership is process-local promises/maps; restart handling marks active runs failed instead of reconciling/resuming. Fix later with durable command ownership, not by moving OpenCode orchestration into Skynet. |
| React session | Current conversation/composer/worklog, tool/file trace grammar, Agents rail, editor, terminal, desktop, streaming fallback, and rail UX are implemented (`frontend/components/chat/*`) | Agents rail attributes `↳` activity to the most recent spawn; subagent pane looks for Skynet runs rather than native OpenCode children; frontend consumes only generic steps. |
| OpenCode-native UI work | A working native embed exists on `feat/opencode-live-embed`; the React port handoff documents native parts/store/markdown-worker behavior | Do not restore the embed as primary chat and do not restart the fidelity treadmill. Port data model/renderer behavior into current React components. |
| Organizations | Better Auth organization/member/invitation tables and server-derived org scope exist (`backend/src/db/auth-schema.ts`, `backend/src/middleware/org.ts`) | Workspace/team/project/repository/session resource authorization is not yet a complete SaaS hierarchy. Extend current auth; do not build a second identity system. |
| Slack | Signature verification and thread-to-run ingress exist (`backend/src/slack/routes.ts`, `backend/src/slack/events.ts`) | Current mapping has a development-organization fallback and outbound watching is process-local; add installation identity and durable outbox later. |
| Knowledge/memory | Org-scoped knowledge and vector search exist; optional team-memory injection/writeback exists (`backend/src/knowledge`, `backend/src/memory`) | Retrieval ledger, citations, correction/deletion policy, and a unified run integration remain incomplete. Do not rebuild the existing store. |
| Skills/playbooks | Org-scoped skill CRUD exists (`backend/src/skills`) | Current “run” behavior mainly updates usage; versioned executable playbook policy is separate future product work. |
| Schedules | Schedule rows, firing history, and a firing loop exist (`backend/src/schedules`) | No multi-replica leases/fencing/durable job ownership; harden the current scheduler rather than adding a second one. |
| Terminal/desktop | Daytona PTY/preview/noVNC proxy paths are real (`backend/src/runs/terminal.ts`, `desktop-proxy.ts`; matching React panes) | Add capability/health/reconnect and scoped-access semantics; do not duplicate surfaces. |
| Artifacts | React derives temporary cards from file steps (`frontend/app/agent/artifacts/derive.ts`) | There is no durable artifact identity/storage/retention/publish model. Build one only for real download/preview/share needs. |

The repository README may still claim the harness permanently lives outside the sandbox. Current code and this locked Stage-1 decision take precedence; fix contradictory documentation as a small follow-up, not by rewriting the runtime to match stale prose.

## Multi-Tenant SaaS Model

Use an explicit resource hierarchy:

```text
SaaS platform
  organization
    workspace or team
      project
        repository connection
        knowledge collections
        playbooks
        automations
        threads
          sessions
            runs
            messages and parts
            children
            artifacts
```

Do not assume every organization uses every layer, but do not collapse them into one global namespace.

Every persisted resource must have an explicit ownership and access scope. Do not infer tenancy from a parent fetched earlier in the request unless the database query or authorization layer enforces it.

Minimum roles may include:

- Organization owner
- Organization administrator
- Team/workspace administrator
- Member
- Viewer
- Service account
- External collaborator

Permissions must be capability- and resource-specific. At minimum distinguish:

- View a session
- Interact with a session
- Cancel or control execution
- Resolve approval
- Use a repository
- Access terminal
- Access desktop/browser
- Read or download artifacts
- Manage playbooks
- Manage automations
- Configure connectors
- Read or administer knowledge and memory
- Use sensitive tools or secrets
- View usage, billing, and audit logs

Do not treat knowledge of an ID as authorization. Every command, query, stream, artifact, terminal, preview, desktop, connector, and knowledge operation must be tenant-scoped.

### Enterprise and SaaS requirements

Design for eventual support of:

- SSO and SCIM
- Domain verification
- Organization invitations and membership lifecycle
- Service accounts and scoped API keys
- Repository installation and per-repository access
- Regional residency where required
- Configurable retention and deletion
- Audit export and compliance APIs
- Customer-controlled secrets
- Usage metering and budgets
- Organization and project quotas
- Feature flags and staged rollout
- Data export and account deletion
- Support impersonation only through explicit, audited break-glass controls

Do not prematurely build all enterprise features, but ensure the canonical identities and authorization boundaries do not make them impossible.

## Identity Model

Persist these as separate identities:

- Organization
- Workspace/team
- Project
- Repository connection
- Skynet thread
- Skynet session
- Execution run/attempt
- Harness provider session
- Sandbox instance
- Sandbox generation
- External connector installation
- External conversation/thread
- External message
- External actor

Do not use `engine_session_id`, `run_id`, `sandbox_id`, or a Slack thread timestamp as a substitute for the canonical Skynet session ID.

```text
Skynet thread
  └── Skynet session
        ├── run 1
        │     ├── harness: opencode
        │     ├── harness session: native-A
        │     ├── sandbox: daytona-X
        │     └── sandbox generation: 1
        └── run 2
              ├── harness: claude
              ├── harness session: native-B
              ├── sandbox: daytona-X or replacement-Y
              └── sandbox generation: 2
```

Required relationship fields should cover:

- `organization_id`
- `workspace_id` where applicable
- `project_id`
- `repository_id`
- `thread_id`
- `session_id`
- `run_id`
- `parent_session_id`
- `root_session_id`
- `originating_part_id`
- `harness_provider`
- `harness_session_id`
- `harness_adapter_version`
- `sandbox_provider`
- `sandbox_id`
- `sandbox_generation`
- `repository_revision`
- `connector_installation_id`
- `external_conversation_id`
- `external_message_id`

## Durable Commands

Every **external/product-level mutation** enters through a durable command. OpenCode's internal message-part updates and tool/subagent transitions are ingested as provider events; do not turn every native internal transition into another command dispatched back to OpenCode. Examples of product commands:

- `session.create`
- `turn.submit`
- `turn.cancel`
- `session.pause`
- `session.resume`
- `interaction.resolve`
- `child.send`
- `playbook.execute`
- `automation.trigger`
- `sandbox.replace`
- `artifact.publish`

Each command needs:

- Stable command ID
- Idempotency key
- Organization and actor identity
- Target resource identity
- Expected version where optimistic concurrency matters
- Creation and acceptance timestamps
- Typed and size-bounded payload
- Authorization decision/provenance
- State and attempt count
- Structured failure information
- Correlation and causation IDs

Use at-least-once delivery with idempotent handlers and consumers. Never claim exactly-once network delivery.

If the client loses the HTTP response after command acceptance, retrying the same idempotency key must observe the original command instead of starting duplicate work.

## Canonical Events

Use two layers so portability does not destroy provider fidelity:

1. **Lossless native capture**: preserve the bounded original OpenCode event/part with native IDs and type before any projection.
2. **Skynet markers/projections**: derive the small cross-provider events the current UI, Slack, audit, and search actually need.

Do not design dozens of normalized tables before capturing real traffic. A first implementation may use an append-only `provider_events` table plus current-state JSONB snapshots/index columns, provided it has tenant scope, native IDs, idempotency, ordering, size bounds, and retention. The current `steps` table remains a compatibility projection during migration, never the only record.

Use a versioned durable envelope:

```ts
type PlatformEvent<TKind extends string, TPayload> = {
  eventId: string;
  sequence: number;
  schemaVersion: number;
  occurredAt: string;

  organizationId: string;
  workspaceId?: string;
  projectId?: string;
  threadId: string;
  sessionId: string;
  runId?: string;
  actorId?: string;

  correlationId?: string;
  causationId?: string;

  kind: TKind;
  payload: TPayload;

  native?: {
    provider: string;
    eventType: string;
    adapterVersion: string;
    providerVersion?: string;
    sessionId?: string;
    parentSessionId?: string;
    messageId?: string;
    partId?: string;
    callId?: string;
    payload: unknown;
  };
};
```

For OpenCode, capture at least:

- `session.created`, `session.updated`, `session.deleted`, `session.status`, `session.error`, and diff/session lifecycle events
- `message.updated`, `message.removed`
- `message.part.updated`, `message.part.delta`, `message.part.removed`
- permission asked/replied
- question asked/replied/rejected
- todo updates and compaction lifecycle
- all known part shapes plus an unknown-part fallback

Use the exact event names and schemas from the pinned source/SDK; do not guess them from this prose.

Representative kinds:

- `session.created`, `session.started`, `session.status_changed`
- `session.interrupted`, `session.completed`
- `run.queued`, `run.started`, `run.retrying`
- `run.cancel_requested`, `run.cancelled`
- `message.created`, `message.completed`
- `part.created`, `part.delta`, `part.completed`, `part.failed`
- `reasoning.updated`
- `tool.requested`, `tool.started`, `tool.output`, `tool.completed`, `tool.failed`
- `file.changed`, `patch.created`
- `child.created`, `child.started`, `child.blocked`, `child.completed`
- `approval.requested`, `approval.resolved`
- `question.requested`, `question.resolved`
- `todo.updated`, `plan.updated`
- `compaction.started`, `compaction.completed`
- `knowledge.retrieved`, `artifact.created`
- `connector.delivery_requested`, `connector.delivery_completed`, `connector.delivery_failed`
- `sandbox.created`, `sandbox.unavailable`, `sandbox.replaced`

Requirements:

- Preserve native event/part before publishing its durable projection to clients
- Monotonic sequence per Skynet session
- No unnecessary global total order
- Explicit causality across sessions
- Stable event identity and idempotent ingestion
- Schema versioning and upcasting
- Bounded payloads
- Safe, bounded native-provider preservation
- Artifact references for large output
- Replay from cursor
- Transactional connector outbox
- Idempotent upsert by provider/native identity where the provider supplies stable IDs
- REST snapshot reconciliation after reconnect and turn completion; OpenCode SSE is the fast path, not the sole source of truth. NOTE (2026-08-06): the historical "Daytona buffers SSE" claim was disproven — the dead-air culprit was an un-scoped `/event` subscription (missing `?directory=`), fixed in the adapter. Reconciliation stays as defense-in-depth.

Token deltas are the latency exception: they may stream through the existing in-memory fast path without one database write per token, provided they carry a stable session/message/part base, queues are bounded, a full authoritative part update is persisted periodically or at completion, and reconnect replaces transient text from the snapshot. Do not trade smooth streaming for per-token transactional writes.

## Hybrid Durable State

Prefer a pragmatic hybrid rather than dogmatic pure event sourcing:

1. Canonical current-state tables for efficient reads
2. Ordered append-only session events for replay, audit, and streaming
3. Periodic materialized snapshots
4. Durable command/job records
5. Transactional connector outbox

Recovery is:

```text
authoritative snapshot at sequence N
              +
ordered events after sequence N
              =
current replicated state
```

Define snapshot cadence, event retention, archive policy, and schema migration before unbounded history becomes infrastructure debt.

## Transaction Boundaries

Where applicable, commit together:

- Command acceptance
- Canonical state mutation
- Event append
- Outbox append

Do not publish an event before canonical state commits. Deliver connectors asynchronously after commit. Make outbox consumers idempotent.

## Durable Runtime

The **Skynet product workflow** must not depend on:

- A browser tab
- A long-running HTTP request
- An SSE connection
- An in-memory promise chain
- One backend process
- The Daytona sandbox remaining awake
- OpenCode-local history being available merely to load already-mirrored product history

In Stage 1, the native OpenCode turn still runs inside Daytona and therefore cannot continue while that sandbox is dead. State this honestly. Skynet must detect the loss, preserve its mirrored history, reconcile provider state, and either resume the native session after wake or mark it interrupted and start an explicit handoff/retry. Do not claim impossible transparent continuation.

Use a durable ordered lane for external commands per Skynet session and concurrency across independent sessions. Do not serialize or reschedule OpenCode's own child agents; OpenCode owns their internal concurrency. Add leases/fencing when multiple backend replicas can accept/dispatch the same external command.

An actor model is acceptable but not mandatory. A PostgreSQL durable queue with leased workers and fencing tokens may be the fastest reliable first implementation. Select infrastructure from measured requirements, operational simplicity, and failure semantics—not marketing.

If leases are used, fencing tokens are mandatory so a stale worker cannot continue writing after losing ownership.

The runtime should:

- Park while idle or awaiting approval
- Wake on commands, events, or schedules
- Reattach to or replace a sandbox
- Reconcile provider state after interruption
- Support realtime subscribers
- Survive backend deployment
- Scale across backend replicas

## Crash Recovery Matrix

Specify and test crashes:

1. Before command persistence
2. After persistence but before dispatch
3. After dispatch but before provider acceptance is known
4. After provider acceptance but before receipt persistence
5. During provider event streaming
6. During a remote tool call
7. When the sandbox OOMs or becomes corrupt
8. After provider completion but before reconciliation
9. During snapshot construction
10. During connector delivery
11. While waiting for approval
12. During deployment or worker reassignment

Never silently rerun potentially destructive work when acceptance is ambiguous. Use explicit states such as:

- `interrupted`
- `reconciliation_required`
- `provider_state_unknown`

Build an operational reconciler for:

- Provider running while Skynet says terminal
- Skynet running while provider is absent
- Missing completion events
- Expired leases
- Commands stuck before dispatch
- Undelivered outbox entries
- Orphan child sessions
- Stale approvals
- Dead sandboxes
- Missing streaming prefixes

## HarnessAdapter Contract

Define a provider-neutral harness boundary. For Stage 1, the OpenCode implementation is a client for `opencode serve` inside Daytona. The interface location is outside the sandbox; the harness loop is not.

```ts
type HarnessCapabilities = {
  resume: boolean;
  cancel: boolean;
  streaming: "none" | "text" | "parts";
  authoritativeHistory: boolean;
  childSessions: boolean;
  approvals: boolean;
  questions: boolean;
  reasoning: boolean;
  todos: boolean;
  patches: boolean;
  usage: boolean;
};

interface HarnessAdapter {
  readonly provider: string;

  capabilities(): Promise<HarnessCapabilities>;
  createSession(input: HarnessSessionInput): Promise<HarnessSessionHandle>;
  resumeSession(handle: HarnessSessionHandle): Promise<HarnessSessionHandle>;
  submitTurn(
    handle: HarnessSessionHandle,
    command: HarnessTurnCommand,
  ): Promise<HarnessTurnReceipt>;
  subscribe(
    handle: HarnessSessionHandle,
    cursor?: HarnessCursor,
  ): AsyncIterable<HarnessEvent>;
  snapshot(handle: HarnessSessionHandle): Promise<HarnessSnapshot>;
  reconcile(
    handle: HarnessSessionHandle,
    checkpoint?: HarnessCheckpoint,
  ): Promise<HarnessReconciliation>;
  cancel(
    handle: HarnessSessionHandle,
    reason: string,
  ): Promise<HarnessOperationResult>;
  resolveInteraction(
    handle: HarnessSessionHandle,
    response: HarnessInteractionResponse,
  ): Promise<HarnessOperationResult>;
}
```

Unsupported behavior returns a typed `unsupported_capability` result. It must not silently no-op or throw an unclassified exception.

OpenCode-specific interpretation belongs only in the OpenCode adapter and OpenCode-native React projection modules. Do not erase native payloads merely to satisfy this interface. Keep the common envelope small and allow versioned provider extensions.

Implement a deterministic fake adapter for contract/failure tests only after the OpenCode resident-server path is stable. Do not spend Stage-1 delivery time implementing a second real agent loop to prove theoretical portability.

## SandboxProvider Contract

Keep sandbox management separate from the harness:

```ts
type SandboxCapabilities = {
  resume: boolean;
  snapshots: boolean;
  terminal: boolean;
  desktop: boolean;
  previewPorts: boolean;
  resourceMetrics: boolean;
  persistentVolume: boolean;
};

interface SandboxProvider {
  readonly provider: string;

  capabilities(): Promise<SandboxCapabilities>;
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  inspect(handle: SandboxHandle): Promise<SandboxState>;
  wake(handle: SandboxHandle): Promise<SandboxHandle>;
  stop(handle: SandboxHandle): Promise<SandboxOperationResult>;
  archive(handle: SandboxHandle): Promise<SandboxOperationResult>;
  destroy(handle: SandboxHandle): Promise<SandboxOperationResult>;
  execute(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<SandboxExecution>;
  terminal(
    handle: SandboxHandle,
    options: TerminalOptions,
  ): Promise<SandboxTerminal>;
  exposePort(handle: SandboxHandle, port: number): Promise<ExposedPort>;
}
```

Daytona-specific URLs, errors, wake behavior, authentication, and retries stay inside the Daytona provider. Destruction must remain an explicit authorized action.

Never expose durable Daytona credentials to React. Issue short-lived scoped grants for terminal, preview, and desktop access.

## Trust Boundary

Treat the sandbox as compromised by default. Do not place primary LLM keys, Slack secrets, unrestricted internal-service credentials, administrative database access, approval policy, or canonical audit credentials inside it.

Current Stage-1 reality is that resident OpenCode needs model-provider access. Until OpenCode/Daytona supports a fully brokered remote-model boundary, use the narrowest practical per-tenant/per-sandbox or gateway credential, rotate/revoke it, constrain spend/model/tool policy outside the sandbox, and never inject organization-wide Slack/internal-service/admin credentials. Record this as accepted residual risk. Do not claim the model key is outside when the code injects it into Daytona.

A sensitive backend tool call should carry:

- Organization and actor
- Session and command
- Requested capability
- Typed, bounded input
- Authorization decision
- Audit correlation ID
- Timeout
- Output-size limit

The model must not be able to modify its audit history or grant itself access.

## Native Resume and Portable Handoff

Distinguish:

```text
Native resume:
OpenCode session A -> OpenCode session A

Portable handoff:
OpenCode session A -> Skynet handoff package -> Claude/Codex session B
```

Do not promise byte-identical migration of provider-private context. A handoff package should include:

- Objective
- Current plan
- Completed and remaining work
- Repository and revision
- Working-tree status and changed files
- Test results and failures
- Blockers
- Decisions and rationale
- Knowledge citations
- Relevant artifacts
- Parent and child outcomes
- User-visible message excerpts
- Explicit provenance identifying imported context

The destination becomes a new harness session and usually a new run/attempt.

## External Conversations and Slack

Persist connector conversations separately from execution sessions:

- Connector installation
- External workspace/channel
- External conversation/thread
- External message
- External actor
- Skynet command
- Skynet session
- Explicit mappings

Slack may be:

1. An input and collaboration surface
2. A searchable knowledge source
3. An action tool
4. An automation trigger
5. A notification destination
6. An approval surface

Each role requires different OAuth scopes, authorization, provenance, and retention.

Acknowledge Slack events quickly, deduplicate by external event ID, persist the command, and execute asynchronously. Use a durable outbox for replies and updates. Respect rate limits and message-update throttling.

## Approvals and Questions

Approvals are durable product objects, not temporary modals. Their request, decision, authorization, and audit record survive browser disconnect, deployment, worker restart, and delayed Slack responses.

OpenCode still owns the native pending permission/question waiter in Stage 1. The audited implementation keeps pending waiters in process memory. Therefore Skynet must never claim the native waiter survived an OpenCode process or permanent sandbox loss. On provider loss, mark the interaction `provider_state_unknown` or `reconciliation_required`; inspect the provider; resume only if the same native request still exists; otherwise require an explicit retry/handoff. A durable Skynet approval decision is not permission to replay a destructive native action blindly.

Store:

- Approval ID
- Organization, session, run, and originating part
- Requested action/capability
- Risk explanation
- Status
- Requester/provider
- Creation and expiry
- Resolver and resolution time
- Authorization evidence
- Resume token/version

React and Slack may both render the request, but only an authorized actor may resolve it. While OpenCode remains alive, route the decision to its native permission/question API. Skynet parks the **product command/workflow** durably while waiting; the native OpenCode waiter remains subject to the provider's lifecycle limitation above.

## Knowledge, Memory, Playbooks, Wiki, and Automation

Keep these concepts separate:

- Session history: one execution's messages, tools, files, errors, and results
- Working memory: temporary active plan, files, facts, and blockers
- Team memory: curated organizational decisions, conventions, ownership, and preferences
- Knowledgebase: searchable source documents, repositories, tickets, Slack, and uploads
- Playbook: reusable versioned executable procedure
- Skill: reusable harness instructions and tool guidance
- Wiki/repository documentation: human-readable organized knowledge with provenance
- Automation: trigger, conditions, execution configuration, and delivery policy

Knowledge retrieval must record source, version, tenant scope, reason, citations, retention, and correction/deletion state.

Playbooks require immutable versions, typed inputs/outputs, required capabilities, tools/connectors, approval checkpoints, retry policy, expected artifacts, provenance, and tests.

Automations require timezone, trigger identity, conditions, idempotency, overlap policy, retry/backoff, dead-letter state, secrets, owner, outputs, pause/cancel, audit, and replay.

A sleeping sandbox never wakes itself. The control plane dispatches the automation and wakes or creates the sandbox.

## React Store

Do not replace the current React session layout or build another chat shell. Extend the current surface incrementally:

- Keep `Conversation`, the composer, `ToolStepRow`, `AgentsRail`, `EditorPane`, `TerminalPane`, `DesktopPane`, rail resizing, session threading, and existing design tokens.
- Replace only the lossy data seam behind them.
- Follow `~/Documents/acme/skynet-react-port/react_port.md`: store OpenCode messages/parts by native ID, apply deltas by part ID, reconcile full parent and child histories, and port proven OpenCode part/markdown behavior into React where it materially improves stability.
- Do not embed the entire OpenCode app as the primary chat. The working embed may remain an advanced/debug/native surface, but Skynet owns the composable React product UX.
- Do not invent an alternate component when an existing current component can accept a richer typed projection.

Stage 1 may start by extending `useRunStream` with versioned provider events/markers and a small native-session store. It does not require a flag-day global state library. Introduce a broader normalized store only after profiling or cross-session UX demonstrates the need.

React consumes authoritative snapshots plus ordered durable events through one normalized session store or equivalent provider-backed external store.

Store:

- Sessions
- Runs
- Messages
- Parts
- Tools
- Children
- Approvals and questions
- Artifacts
- Transport state
- Execution state
- Provider capabilities

Required semantics:

- Stable entity IDs
- Generation guards
- Deterministic, side-effect-free reducers
- Authoritative snapshot replacement
- Touched and tombstone tracking
- Pending orphan handling
- Delta buffering with explicit bases
- Event deduplication and sequence tracking
- Batched/coalesced event application
- Recursive child hydration
- Selector-level subscriptions
- Reconciliation after reconnect, visibility regain, online regain, completion, and backend restart
- Native-ID-backed child/tool attribution; never display-order heuristics
- Compatibility projection for existing `ApiStep` consumers during migration

Transport state and execution state are separate:

```text
transport: connecting | connected | reconnecting | reconciling | offline | failed
execution: queued | running | waiting_approval | waiting_answer | retrying |
           interrupted | cancelling | cancelled | completed | failed |
           reconciliation_required
```

Do not let uncontrolled polling and SSE mutate state simultaneously.

### Current codebase reuse map

| Current seam | Keep | Change narrowly |
|---|---|---|
| `backend/src/engines/opencode-server.ts` | Resident server, pre-prompt SSE, REST reconciliation, child discovery, serialized part handling | Capture all native events/IDs first; stop dropping unknown types; emit richer versioned frames alongside current steps |
| `backend/src/engines/types.ts` | Adapter boundary and delta/update callbacks | Add native event/snapshot capability without forcing everything into `EmitStep` |
| `backend/src/runs/routes.ts` | Authenticated replaying SSE, heartbeat, no-buffer headers, step upsert behavior | Add generic versioned event frames/cursor; keep old `step/delta/done` during migration |
| `backend/src/db/schema.ts` | Runs, engine session ID, sandbox ID, existing steps compatibility | Add the minimum raw-provider event/snapshot/ID persistence; do not prematurely explode every part into bespoke tables |
| `frontend/components/chat/use-run-stream.ts` | EventSource fallback, step upsert, terminal refetch | Add event reducer/native session subscription and reconciliation |
| `frontend/components/chat/conversation.tsx` | Conversation/composer/worklog structure | Render typed native parts/markers; preserve progressive narration |
| `frontend/components/chat/tool-step-row.tsx` and `types.ts` | Existing trace grammar and parsers | Accept stable native IDs/lifecycle/full payload; add safe unknown renderer |
| `frontend/components/chat/agents-rail.tsx` | Existing rail/card visual design | Replace most-recent-card attribution heuristic with native child session ID/parentID/status |
| `frontend/components/chat/subagent-pane.tsx` | Pane/navigation patterns | Source native OpenCode child sessions instead of assuming only Skynet child runs |
| `frontend/components/chat/editor-pane.tsx` | Existing touched-file UX | Feed native file/patch/diff data where available |
| `frontend/components/chat/terminal-pane.tsx`, `interactive-terminal.tsx`, `desktop-pane.tsx` | Existing terminal/noVNC surfaces | Add capability/health states; do not build duplicates |
| `frontend/app/agent/artifacts/derive.ts` | Temporary compatibility derivation | Replace only when durable artifact records are a real product requirement |

## Prompt Submission Transaction

Prompt submission requires:

- Stable client-generated optimistic message ID
- Idempotency key and command ID
- Draft retained or restorable
- Sending, queued, accepted, failed, and ambiguous states
- Confirmation against authoritative state
- Visible error
- Retry and edit
- Abort/stop
- Duplicate-submit prevention
- IME composition guard

If acceptance is ambiguous, show reconciliation rather than deleting the message or sending again automatically.

Never silently swallow failures.

## Rendering and Timeline

Project the timeline purely from deterministic session projection state, which may retain provider-native parts behind a versioned adapter. Provide typed renderers for:

- Text
- Reasoning
- Tool lifecycle
- Commands
- Files and patches
- Errors
- Approvals
- Questions
- Todos/plans
- Artifacts
- Child sessions
- Compaction
- Knowledge citations
- Provider extensions

Unknown provider parts receive a safe fallback. Never discard them silently.

Streaming should use per-part subscriptions, animation-frame batching, bounded delta queues, stable block identity, incomplete-Markdown handling, and worker-based parsing/highlighting only where profiling justifies it.

Scroll behavior must support detachment, jump-to-latest, unread count, content-growth anchoring, prepended-history preservation, saved positions, expanding media/code, and long-history virtualization.

## Fanout

OpenCode orchestrates ordinary subagents. Skynet does not create a parallel fanout engine for the same work.

Project OpenCode's native child sessions as a recursive session graph. Use `parentID`, child session ID, task ToolPart metadata (`parentSessionId`, `sessionId`, model/background metadata), native status, and child messages. Never infer ownership from display order, labels, or `↳` prefixes.

Support:

- Exact parent/root/originating-part relationships
- Child objective and role
- Independent status and timeline
- Grandchildren
- Blockers and approvals propagated to parent views
- Recursive reconnect and completion reconciliation
- Cancellation propagation policy
- Resource/concurrency limits
- Explicit child result artifacts

Only promote a child into a separate Skynet-controlled run/sandbox when product policy explicitly requires independent isolation, budgets, ownership, scheduling, or a different harness/provider. That is cross-session product orchestration, not the default implementation of OpenCode's `task` tool.

OpenCode v1.18.7 supports configurable native subagent depth and `task_id` continuation; background subagents are experimental and must be capability/flag gated. Test the configured supported depth instead of assuming unlimited nesting.

Test one child, nested children, 5 concurrent children, and 20 concurrent children with interleaved events and failures.

## Terminal, Preview, and Desktop

Preserve useful Daytona terminal/noVNC/preview behavior while making availability health-driven.

Require:

- Capability and health handshake
- Connecting, connected, sleeping, disconnected, expired, and retry states
- Short-lived scoped access grants
- Terminal continuity across tab changes where possible
- Detachable terminal autoscroll
- Preview port health
- Desktop load, failure, and reconnect behavior

Do not infer sandbox availability from a run or harness-session ID.

## Backpressure, Storage, and Quotas

Define limits for:

- Event and delta size
- Subscriber buffer size
- Tool output
- Artifacts
- Replay tail
- Active sessions and children per tenant
- Concurrent runs
- Session retention
- Slow consumers
- Slack updates
- Provider rate limits

Large logs, patches, screenshots, recordings, binaries, and tool outputs belong in artifact/blob storage. Events contain bounded metadata and immutable artifact references.

Apply quotas at organization and optionally workspace/project level. Make quota failures explicit and recoverable.

## Extension Model

Use declarative, server-authorized extension slots:

- Part renderer
- Composer attachment
- Turn action
- Session header action
- Right-rail tab
- Artifact preview
- Approval renderer
- Connector-origin badge
- Knowledge citation renderer

Do not execute arbitrary remote connector-provided React code. The backend resolves allowed descriptors; the frontend renders trusted implementations.

## Observability

Instrument:

- Command acceptance and queue latency
- Harness startup and sandbox wake/create latency
- Model time-to-first-token and completion latency
- Event persistence/publish latency
- Reconnect rate and reconciliation duration
- Snapshot age and creation time
- Lease contention and stale-writer rejection
- Duplicate commands
- Orphaned/ambiguous executions
- Provider reconciliation failure
- Fanout and child concurrency
- Connector delivery latency/failure
- Slack rate limiting
- Approval wait time
- Tool timeouts and truncation
- Client dropped/coalesced deltas
- Long-session render performance

Use correlation IDs across command, run, provider session, sandbox, tool, event, and connector delivery.

## Coding Guidelines

### Think before coding

- State assumptions and invariants before implementation.
- If multiple interpretations materially change the design, surface them.
- Prefer the simplest approach that satisfies measured requirements.
- Do not disguise unknowns as confidence.
- Identify what evidence would falsify the proposed design.

### Make surgical changes

- Every changed line must trace to the active phase and acceptance criteria.
- Do not refactor unrelated code.
- Preserve user changes.
- Remove only orphans introduced by the current change.
- Keep migrations additive and reversible until cutover is proven.

### Prefer deletion and reuse

- Search the whole repository before creating a helper, hook, component, state machine, or adapter.
- Extend an existing correct primitive when it preserves one pattern per concern.
- Delete superseded compatibility code after verified cutover, not before.
- Do not create speculative generic frameworks.
- Before implementing agent behavior, inspect the pinned OpenCode source/API and write `REUSE`, `PROJECT`, or `BUILD` beside the requirement.
- `REUSE`: call or proxy the native feature as-is.
- `PROJECT`: preserve native events/IDs and render the feature in Skynet.
- `BUILD`: implement only product behavior OpenCode does not supply.
- A proposal that says `BUILD` for native fanout, tool lifecycle, native session history, todos, diffs, permission/question transport, abort, fork/revert, compaction, PTY, commands, agents, skills, or MCP must include evidence that the pinned OpenCode feature is insufficient.

### Maintain boundaries

- One job per module/function/component.
- Split units that mix transport, persistence, normalization, policy, and presentation.
- Domain types must not import React, Slack, OpenCode, or Daytona SDK types.
- Provider adapters depend inward on canonical interfaces; canonical domain code never depends on providers.
- UI projections remain pure and deterministic.
- Route handlers validate, authorize, dispatch, and translate responses; they do not run orchestration logic.

### TypeScript and React

- Use precise discriminated unions and exhaustive checks.
- No `any`, unclassified string bags, or unsafe assertions.
- Validate external/provider payloads at trust boundaries.
- Use `satisfies` where it improves exhaustiveness without widening.
- Use ESM and async/await.
- Use modern immutable operations where runtime support is established.
- Follow React 19 idioms; do not add reflexive memoization.
- Keep streaming state outside component-local ad hoc arrays.
- Avoid index keys for changing timelines.
- Never use effects to repair a data-model defect.

### Errors

- Do not swallow errors.
- Use structured error codes with safe user messages and internal diagnostic context.
- Distinguish validation, authorization, conflict, unsupported capability, provider failure, sandbox failure, timeout, ambiguous acceptance, and retry exhaustion.
- Preserve causal chains without leaking secrets.
- Every recoverable error should expose the recovery action.

### Concurrency

- Document ownership and ordering for every mutable resource.
- No check-then-write without transactional or version protection.
- No process-local lock presented as distributed safety.
- No unbounded queues or buffers.
- Cancellation must be cooperative, durable, and observable.
- Handle duplicated, delayed, reordered, and missing external events.

### Security

- Deny by default.
- Scope queries by tenant at the data-access layer.
- Minimize credentials and capabilities.
- Redact secrets from events, logs, traces, errors, and native payload retention.
- Audit sensitive access and approvals.
- Destructive operations require explicit targets and authorization.
- Never trust provider event content merely because it came through an authenticated connection.

### Performance

- Establish budgets before optimizing.
- Measure database queries, event rates, render cost, memory, and reconnect time.
- Batch high-frequency deltas.
- Avoid N+1 hydration of messages, parts, children, permissions, and artifacts.
- Do not wake a sandbox to read session history.
- Keep initial session snapshots bounded and paginated.
- Add indexes based on actual access paths and explain each one.
- Benchmark long sessions and high fanout, not only empty demos.

### Dependencies

- No new dependency without explaining why existing code or platform primitives are insufficient.
- Consider maintenance, security, bundle size, operational burden, and exit path.
- Wrap provider SDKs at adapter boundaries.
- Pin and contract-test provider behavior that can drift.

### Tests and verification

- Reproduce a defect with a test before fixing it when feasible.
- Test contracts and invariants, not implementation trivia.
- Run lint, typecheck, unit, integration, migration, and browser checks appropriate to the change.
- Read actual failure output; do not report success from exit assumptions.
- Verify both happy and recovery paths.
- Keep deterministic fake providers for fault injection.

### Code review closing sweep

Before declaring a phase complete, check:

1. Did this duplicate an existing primitive?
2. Does any unit now perform multiple jobs?
3. Did the change introduce dead exports, props, migrations, flags, or code paths?
4. Are there legacy patterns or unsafe casts in changed files?
5. Are there competing patterns for the same concern?
6. Are authorization and tenant scopes enforced at every new boundary?
7. Are errors visible and actionable?
8. Are queues, payloads, and retries bounded?
9. Can the change be rolled back safely?
10. Is there concrete verification evidence?

## Delivery Strategy: Fast Without Recklessness

Fast means reducing rework and validating risky assumptions early. It does not mean implementing every layer simultaneously.

Use thin vertical slices:

1. Capture one real OpenCode event/snapshot fixture from the pinned version.
2. Classify the capability as `REUSE`, `PROJECT`, or `BUILD`.
3. Define one invariant and lock it with a failing contract test.
4. Preserve the native payload/IDs through the smallest backend path.
5. Project it through an existing React component where possible.
6. Reconcile against REST truth and inject one failure.
7. Measure it and compare with the native OpenCode UI/reference behavior.
8. Commit a reviewable slice.

Prioritize irreversible/high-risk decisions first:

- IDs and tenancy
- Event schema/versioning
- Transaction boundaries
- Trust boundary
- Command idempotency
- Provider interfaces
- Migration strategy

Defer reversible polish until the underlying contract is stable.

Use feature flags and cohort rollout. Maintain old behavior until the new path proves correctness. Do not dual-write indefinitely; set exit criteria and removal dates.

## Implementation Phases

### Phase 0 — Design and evidence

- Map current flows with exact file references.
- Identify mutation paths and information loss.
- Produce the `REUSE` / `PROJECT` / `BUILD` matrix against pinned OpenCode v1.18.7.
- Define invariants and schemas.
- Confirm the locked Stage-1 resident-OpenCode architecture; list only evidence that would justify revisiting it.
- Design migrations, compatibility, security, tests, and rollback.
- Do not begin broad UI implementation.

### Phase 1 — Lossless OpenCode bridge and current-UI markers

- Preserve bounded raw OpenCode events and full message/part snapshots before translation.
- Persist native provider/session/parent/message/part/tool/call IDs and adapter/provider versions.
- Keep the current `steps` stream as a compatibility projection.
- Emit richer versioned events through the current authenticated SSE route.
- Render accurate tool lifecycle and native-ID-backed subagent cards in the current React UI.
- Reconcile parent plus child histories on completion/reconnect (defense-in-depth; the 2026-08-05 dead-air bug was an un-scoped `/event` subscription, since fixed).
- Add fixtures/tests for text, reasoning, tools, subtask/task dedupe, child sessions, status/error, permissions, questions, todos, diff, compaction, and unknown parts.

### Phase 2 — Product durability around resident OpenCode

- Resident OpenCode `HarnessAdapter` over REST/SSE
- Daytona `SandboxProvider`
- Durable external commands/idempotency, provider mappings, cursor/snapshots, and connector outbox
- Product approval/question records and route decisions to OpenCode's native APIs
- Move organization credentials, connector secrets, policy, audit, schedules, and durability outside the sandbox
- Reconciliation with current native sessions and explicit interrupted/provider-unknown states
- Deterministic fake adapter/provider for contract and fault tests
- No remote-tool rewrite and no external agent loop in this phase

### Phase 3 — Durable runtime

- Per-session mailbox
- Leased workers or justified actor runtime
- Fencing tokens
- Restart recovery
- Cancel, pause, resume
- Operational reconciler
- Backpressure and quotas

### Phase 4 — React replicated store

- Incremental native session store behind the existing session UI; no shell rewrite
- Native-ID-keyed messages, parts, tools, and children
- Deterministic reducers
- Snapshot/event ingestion
- Cursor reconnect
- Recursive children
- Status separation
- Store contract tests

### Phase 5 — Session UX migration

- Preserve current conversation/composer/rail layout
- Typed OpenCode part renderers inside the current UI
- Transactional composer
- Approvals and questions
- Progressive Markdown
- Correct scrolling
- Responsive Chat/Work/Agents modes
- Terminal/desktop health UX

### Phase 6 — Team platform

- Slack installation, identity, and conversation mappings
- Durable connector outbox
- Knowledge retrieval ledger and citations
- Scoped team memory
- Versioned playbooks and skills
- Automations and triggers
- Repository documentation/wiki
- Cross-surface approvals
- Admin, usage, and audit surfaces

### Phase 7 — Portability and scale

- Claude/Codex adapter spike
- Portable handoff package
- Second real sandbox-provider spike
- Load/failure/tenant testing
- Provider capability matrix
- Retention, archive, and cost tuning
- Optional measured external-loop/remote-tool spike; not a prerequisite for Stage-1 product delivery

## Migration Requirements

Avoid a flag-day rewrite:

- Keep current endpoints temporarily.
- Add mappings for legacy IDs.
- Dual-write only where correctness is demonstrable.
- Compare old and new projections through a read-only diagnostic.
- Record mismatches.
- Feature-flag the new React store.
- Roll out by internal users, organization, project, or session cohort.
- Do not pretend old step records contain native data that was never stored.
- Define active-session behavior during deployment.
- Provide rollback for every phase.
- Remove the old path only after explicit parity and failure gates pass.

## Required Test Matrix

Backend:

- Command idempotency and ambiguous HTTP response
- Duplicate, delayed, missing, and reordered provider events
- Session sequence allocation
- Transactional state/event/outbox behavior
- Stale fencing token rejection
- Snapshot replacement, deletion, and shorter corrected content
- Orphan part before message
- Recursive child graph reconstruction
- Unsupported provider capabilities
- Sandbox failure and replacement
- Approval persistence and resume
- Connector retry and deduplication
- Tenant isolation on every resource type

Frontend:

- Stale-generation rejection
- Duplicate event
- Tombstone and authoritative removal
- Delta before base
- Corrected shorter text
- Reconnect and snapshot replacement
- Session switch during streaming
- Recursive child update
- Transport/execution state separation
- Failed send restores draft
- Ambiguous send reconciles
- IME-safe submission
- Progressive incomplete Markdown
- Scroll anchoring and history prepend
- Terminal/desktop failure and recovery
- Keyboard and screen-reader behavior

System and failure injection:

1. Kill backend during a long turn.
2. Kill the session worker.
3. Sleep the Daytona sandbox.
4. OOM/corrupt the sandbox during a tool call.
5. Drop the browser mid-stream.
6. Drop the HTTP response after command acceptance.
7. Deliver duplicate and reordered events.
8. Run two backend replicas against one session.
9. Deploy during execution.
10. Fail Slack delivery repeatedly.
11. Delay approval for hours.
12. Replace the sandbox and continue.
13. Run 5 and 20 interleaved child agents.
14. Attempt cross-organization access to every surface.

## Phase 0 Required Deliverable

If the request is analysis/architecture only, stop after this deliverable. If the request is to build or fix the product, make this a concise implementation checkpoint and then continue automatically into the smallest Phase-1 vertical slice; do not spend the entire task rewriting plans while known event loss remains.

The blocking checkpoint is intentionally small:

1. Current OpenCode event-to-database-to-SSE-to-React flow with exact file references
2. `REUSE` / `PROJECT` / `BUILD` matrix for the requested slice
3. Confirmed information loss and the user-visible defect it causes
4. Exact native fixtures/events/REST snapshots that prove the provider contract
5. Smallest compatible schema/API/store change; current components/endpoints retained
6. Tenant/security/payload-size/secret-redaction constraints for that slice
7. Reconciliation, migration, rollback, and active-session behavior
8. Contract, failure, typecheck, and browser verification to run

Do not block Phase 1 on designing every future workspace, billing, playbook, wiki, provider, or actor-runtime table. Grow the broader design—tenant model, command envelope, event taxonomy, adapter/provider contracts, Slack mappings, approvals, knowledge/memory/automation, crash matrix, quotas, observability, and portability—when its phase becomes active.

Do not claim implementation completion from the design document.

## Success Criteria

The platform is not complete until it demonstrates:

1. A lost HTTP response cannot cause a duplicate turn.
2. Backend restart does not falsely terminate recoverable work.
3. A sleeping sandbox can resume, and a dead sandbox produces explicit reconciliation/interruption plus an honest replacement/handoff path.
4. Session history loads without waking the sandbox.
5. Browser reconnect reproduces authoritative state exactly.
6. Twenty interleaved child agents retain correct lineage and status.
7. A child approval can be resolved from React or Slack.
8. Two backend replicas cannot concurrently own one session lane.
9. A stale worker cannot write after losing its lease.
10. Slack and React share one session truth.
11. Knowledge retrieval includes scope, provenance, and citations.
12. Large output is bounded and stored as artifacts.
13. Cross-organization access fails across all surfaces.
14. OpenCode can hand work to Claude/Codex explicitly without lying about native resume.
15. React's product shell and common event protocol do not require a rewrite when the harness changes; provider-specific adapters/renderers remain allowed and isolated.
16. Daytona can be replaced without replacing the canonical session model.
17. Errors are visible, classified, and actionable.
18. Long sessions and high fanout meet defined latency and memory budgets.
19. Organization administrators can audit who initiated, approved, changed, or accessed sensitive work.
20. Every shipped phase has tests, rollout controls, rollback, and measured evidence.
21. Native OpenCode fanout, tool lifecycle, sessions, permissions/questions, todos, diffs, abort, fork/revert, compaction, commands, skills, and MCP are reused or projected rather than reimplemented without evidence.
22. The current React conversation/composer/rail/terminal/desktop UX remains reusable while native IDs replace heuristic attribution.

## Final Operating Rules

- Skynet owns durable **product** truth, tenancy, policy, connectors, audit, and external command acceptance.
- OpenCode owns native in-session agent/subagent orchestration in Stage 1.
- Daytona is the untrusted execution workspace that currently contains the resident OpenCode harness.
- Preserve native OpenCode events and IDs before projecting them.
- Reuse native features; project them into the current UI; build only the missing product layer.
- A `HarnessAdapter` outside the sandbox does not imply the harness loop moved outside.
- External-loop/remote-tool architecture is optional later work, not a Stage-1 prerequisite.
- OpenCode, Claude, Codex, and future agents are replaceable harness providers.
- Daytona and future compute systems are replaceable sandbox providers.
- React, Slack, API, schedules, and other channels are projections and command surfaces.
- Organization and resource authorization are enforced server-side at every boundary.
- At-least-once delivery plus idempotency is the default distributed-systems model.
- Correctness under restart, reconnect, duplication, and concurrency is a product feature.
- Fast delivery comes from thin verified slices, not shortcuts around the domain model.
- Do not polish over information loss.
- Do not introduce infrastructure without evidence.
- Do not declare success without executable verification.
