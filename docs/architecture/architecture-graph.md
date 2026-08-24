# useAgent architecture graphs

Diagram companion to [`docs/architecture/ARCHITECTURE.md`](./ARCHITECTURE.md), verified against the
`origin/main` base commit **`35ab7cd3`**. All paths are repository-root-relative.

## A. System context

```mermaid
graph LR
  WEB["Web UI"]
  SLACK["Slack"]
  AUTO["Schedules / Skills"]
  CLI["CLI REST client"]
  MCP["Local stdio MCP"]
  ACCEPT["acceptRunCommand"]
  DB[("Postgres durable state")]
  PUMP["Thread claim + fleet admission"]
  WORKER["Worker"]
  CHAT["Direct Chat provider<br/>no sandbox"]
  SANDBOX["Per-thread Cube/Daytona sandbox<br/>OpenCode / ACP / Pi"]
  GATEWAY["Knowledge + provider gateway"]
  SSE["Thread SSE"]
  UI["Thread store + UI"]

  WEB --> ACCEPT
  SLACK --> ACCEPT
  AUTO --> ACCEPT
  CLI --> ACCEPT
  MCP -->|fleet client over REST| ACCEPT
  ACCEPT --> DB
  DB --> PUMP --> WORKER
  WORKER -->|engine = chat| CHAT
  WORKER -->|agent engine| SANDBOX
  SANDBOX -->|run-scoped capability| GATEWAY
  CHAT --> WORKER
  SANDBOX --> WORKER
  WORKER --> DB
  DB --> SSE
  WORKER -. transient deltas/native frames .-> SSE
  SSE --> UI
```

Grounding: acceptance `backend/src/commands/service.ts:L81-L190`; CLI REST reuse
`packages/agent-client/src/fleet.ts:L1-L7`; local stdio MCP `packages/cli/src/mcp.ts:L211-L215`;
Chat branch `backend/src/worker.ts:L357-L366`; provider dispatch
`backend/src/engines/index.ts:L192-L216`; thread SSE `backend/src/runs/routes.ts:L954-L1000`.

## B. Run lifecycle and execution split

```mermaid
sequenceDiagram
  participant C as Channel / CLI
  participant A as acceptRunCommand
  participant DB as Postgres
  participant P as Thread pump
  participant W as Worker
  participant E as Chat provider or sandbox engine
  participant TS as turnStream
  participant SSE as thread-events SSE

  C->>A: create run
  A->>DB: commit run + run.create + admission
  A-->>SSE: created signal
  P->>DB: claim oldest queued command
  P->>DB: admission decision / lease
  P->>W: spawn admitted run
  alt engine = chat
    W->>E: direct streaming chat completion
  else agent engine
    W->>E: one provider turn in thread sandbox
  end
  E-->>W: deltas, events, completion
  W-->>TS: transient answer/reasoning deltas
  TS-->>SSE: delta frames
  W->>DB: durable steps/events and terminal path
  W-->>SSE: step/native/done/settled frames
  SSE-->>C: one thread-scoped stream in browser clients
```

Grounding: atomic accept `backend/src/commands/repo.ts:L104-L129`; claim
`backend/src/commands/dispatch.ts:L45-L74`; fleet gate `backend/src/fleet/pump.ts:L16-L35`; Chat
execution `backend/src/worker.ts:L623-L745`; agent dispatch `backend/src/worker.ts:L927-L944`;
transient stream `backend/src/runs/turn-stream.ts:L1-L20`; SSE subscriptions
`backend/src/runs/routes.ts:L1048-L1070`.

## C. Durable and transient event lanes

```mermaid
graph TD
  ENGINE["Chat/provider output"]
  STEPS["runs + steps<br/>durable"]
  RAW["provider_events<br/>durable native capture"]
  OUTBOX["canonicalization_outbox"]
  CANON["canonical_events<br/>durable provider-neutral"]
  DELTA["turnStream<br/>process-local, transient"]
  SSE["thread-events SSE multiplexer"]
  STORE["frontend thread store"]

  ENGINE --> STEPS --> SSE
  ENGINE --> RAW --> OUTBOX --> CANON --> SSE
  ENGINE -. live answer/reasoning .-> DELTA -. delta frames .-> SSE
  SSE --> STORE
  STORE -->|settle clears live text| STORE
```

Raw persistence/publication: `backend/src/runs/provider-events.ts:L119-L156`. Canonical sealing and
publication: `backend/src/runs/canonicalization-outbox.ts:L160-L202`. Transient buffering and
eviction: `backend/src/runs/turn-stream.ts:L54-L140`. Frontend clearing:
`frontend/components/chat/thread-store.ts:L327-L331`.

## D. Terminal-path matrix

```mermaid
flowchart TD
  NORMAL["Worker / recovery / lease loss / zombie running cancel"] --> FINALIZE["finalizeRun"]
  FINALIZE --> COMPLETE["guarded completeRun"]
  FINALIZE --> SIDE["lease release + eligible outboxes + settled signal"]

  QCANCEL["Queued cancel"] --> QDIRECT["direct completeRun in cancel transaction"]
  QDIRECT --> QFOLLOW["settle run.create + release lease + admission canceled + cancelled signal"]

  BADADM["Invalid admission"] --> ADIRECT["direct completeRun"]
  ADIRECT --> AFOLLOW["admission failed + command settled by pump"]

  LEGACY["Commandless legacy/orphan recovery"] --> SQL["direct bulk SQL terminal update"]
```

Normal finalization: `backend/src/runs/finalize.ts:L140-L276`. Queued-cancel bypass:
`backend/src/commands/cancel.ts:L64-L123`. Invalid-admission bypass:
`backend/src/fleet/admission.ts:L93-L100`. Commandless-recovery bypass:
`backend/src/commands/dispatch.ts:L145-L160`.

## E. Production credential boundary

```mermaid
graph LR
  STORE["Encrypted org/provider credentials"]
  BACKEND["Trusted backend/gateway memory"]
  TOKEN["Short-lived signed run/thread capability"]
  SANDBOX["Untrusted sandbox"]
  TOOLS["Gateway tools / provider proxy"]

  STORE --> BACKEND
  BACKEND -->|redaction values only| BACKEND
  BACKEND --> TOKEN --> SANDBOX
  SANDBOX -->|capability, no tenant arg| TOOLS
  BACKEND --> TOOLS
  STORE -. no env, names, or files in production .-> SANDBOX
```

Production gateway-only mode: `backend/src/secrets/inject.ts:L128-L144` and
`backend/src/secrets/inject.ts:L238-L263`. No-op sandbox materialization:
`backend/src/secrets/inject.ts:L470-L480`. Token identity and expiry:
`backend/src/knowledge/gateway/token.ts:L35-L48`; live-run revalidation:
`backend/src/knowledge/gateway/run-authorization.ts:L40-L76`. Checked-in production selection:
`deploy/hetzner/configure-host.sh:L222-L243`.

## F. Core relations with nullability

```mermaid
erDiagram
  runs ||--o{ steps : "required runId"
  runs ||--o{ provider_events : "required runId"
  runs ||--o{ canonical_events : "required runId"
  runs ||--o| canonicalization_outbox : "optional one-to-one"
  runs o|--o{ commands : "nullable command.runId"
  runs ||--o| run_admissions : "optional one-to-one"
  runs ||--o{ sandbox_leases : "required runId"
  runs o|--o{ runs : "nullable parentRunId"
  projects o|--o{ runs : "nullable projectId"
  projects o|--o{ tasks : "nullable projectId"
  runs ||--o{ artifacts : "required runId"
```

FK/nullability evidence: `backend/src/db/schema/runs.ts:L42-L59`,
`backend/src/db/schema/runs.ts:L146-L162`, `backend/src/db/schema/provider-events.ts:L11-L37`,
`backend/src/db/schema/canonical.ts:L29-L83`, `backend/src/db/schema/commands.ts:L16-L29`,
`backend/src/db/schema/fleet.ts:L59-L65`, `backend/src/db/schema/fleet.ts:L107-L113`,
`backend/src/db/schema/tasks.ts:L24-L33`, `backend/src/db/schema/artifacts.ts:L25-L54`.

## G. Deployment constraint

```mermaid
graph LR
  ONE["One backend per database"]
  LOCAL["Process-local buses + turnStream + capture drain"]
  DB["Durable replay in Postgres"]
  FUTURE["Multi-replica realtime requires durable coordination"]

  ONE --> LOCAL
  LOCAL --> DB
  DB --> FUTURE
```

The boot advisory lock and rationale are in `backend/src/db/single-backend.ts:L31-L43` and
`backend/src/db/single-backend.ts:L52-L88`. This is a checked-in deployment constraint, not a claim
that every local development process enables strict refusal.

---

Verified against `origin/main` base commit **`35ab7cd3`**.
