# useAgent frontend

The frontend is the product UI for useAgent. It runs on `:3400` by default, uses Next.js 16, and talks to the backend through the same-origin `/api/*` proxy.

## Route Map

| Route | Purpose |
|---|---|
| `/` | Lightweight chat surface. No sandbox. |
| `/agent/new` | New task composer for starting agent runs. |
| `/session/[id]` | Thread view for a live or settled agent run. |
| `/skills` | Org skills catalog. |
| `/playbooks` | Playbooks over the same skill substrate. |
| `/wiki` | Published knowledge documents. |
| `/artifacts` | Files and outputs from agent runs. |
| `/secrets` | Encrypted org secrets manager. |
| `/review` | GitHub pull request review workspace. |
| `/agent/automations` | Recurring-work list, editor, history, and run-now controls. |
| `/settings` | General workspace settings, usage, team cards, and provider connections. |

`/session/new` redirects to `/agent/new`.

## UI Layers

| Layer | What it owns |
|---|---|
| `app/` | Route entry points, metadata, and page-level composition. |
| `components/shell/` | The shared framed app shell, top nav, and sidebars. |
| `components/chat/` | Chat, task composer, thread view, event stream, and timeline rendering. |
| `components/ai/` | Ported AI primitives from beautiful-ui. |
| `components/prompt-kit/` | Prompt and markdown primitives used by chat surfaces. |
| `components/base/thinking-orb/` | The loading orb used in live session boot states. |
| `lib/` | Backend fetch helpers and thin client wrappers. |

`app/layout.tsx` sets the fonts and theme shell. `components/shell/app-shell.tsx` provides the boxed product frame with the shared nav and scrollable main area.

## Event Flow

The frontend uses three different event flows:

- The lightweight chat surface sends text to `POST /api/chat` and renders the streamed response plus read-only retrieval citations.
- The session surface opens one SSE connection per root thread through `useThreadStream`, decodes frames with `@useagent/agent-client`, and feeds them into the thread store.
- Ambient management surfaces share one reference-counted `EventSource` on `GET /api/runs/changes`. Run, artifact, Automation, and provider-connection invalidations trigger authoritative API refetches instead of carrying record or credential payloads.

That separation is deliberate:

- the client package owns the transport, reconnect, and reducer logic;
- the frontend owns rendering and interaction state;
- the backend owns the durable event log and canonical thread data.

The ambient stream is backed by a process-local backend bus and is live-only.
Browser reconnect creates a new subscription; the server does not assign event
IDs or replay invalidations missed while disconnected. Automations retain
bounded snapshot polls. Provider Connections loads on mount and refetches after
a received invalidation or manual refresh; only a pending interactive Codex
login adds a two-second status poll.

## Composer

The main composer lives in `components/chat/composer.tsx` and is reused across the chat and agent surfaces.

### What It Sends

For a new task, `NewTaskComposer` sends the following to `POST /api/runs`:

- prompt text
- engine
- model when the selected engine exposes a model catalog
- memory scope
- selected repositories
- per-repo branch overrides
- attached uploads
- pinned skill or playbook

For replies, the shared composer sends:

- prompt text
- engine
- model when supported by the current thread
- memory scope
- a typed command intent when the text matches the active slash-command catalog
- attachment ids when uploads are attached

### Send, Steer, Stop

The composer action label is stateful:

- `Send` appears when there is no live run to steer.
- `Steer` appears when a run is live and the draft will become the next reply in the same thread.
- `Stop this run` appears when a run is live and the composer can issue the durable cancel action instead of submitting a new reply.

The important detail is that `Steer` does not change the backend route. It is still a threaded reply. The label exists so the UI makes the live-state intent obvious to the user.

## Design System Boundary

The frontend uses three presentation layers:

- `components/base/` is the canonical tokenized primitive kit (dialog/overlay primitives live in `components/base` and `components/session-ui`).
- `components/ai/` holds the imported AI-native cards, loaders, and timeline primitives.
- `components/prompt-kit/` holds the prompt and markdown primitives.

The page shell and chat surfaces are built on AlignUI semantic tokens, not raw color literals. Fonts are declared in `app/layout.tsx`:

- `Inter` for body text
- `Inter Tight` for display text
- `JetBrains Mono` for code and run output

## Chat Surfaces

- `/` is a direct chat page with read-only retrieval and a Promote to Agent action.
- `/agent/new` is the real task kickoff surface.
- `/session/[id]` renders one threaded conversation, a live timeline, the terminal, the desktop view, artifacts, and subagent chips.
- `NEXT_PUBLIC_CANONICAL_TIMELINE=1` enables the canonical timeline path. The native timeline remains the default fallback.
- The canonical path folds tool lifecycle updates into stable rows, preserves semantic MCP server/tool identity, duration and provider status, keeps unknown native payloads available, and renders structured child state without display-text inference.
- Canonical child cards preserve durable child identity across realtime updates and replay, including terminal-only completions and exact native-step ownership. These are local event-contract guarantees, not proof of every live provider journey.

## Development

The frontend package has its own scripts:

```bash
bun run dev
bun run build
bun run start
bun run typecheck
bun run lint
bun run lint:fix
bun run test
```

Notes:

- `bun run dev` starts Next.js on `:3400`.
- `bun run start` serves the built frontend on `:3400`.
- `bun run test` runs tests under `components/`. Run `app/` tests explicitly when changing route-local data modules.
- `bun run lint` and `bun run lint:fix` use Biome.

## Current Versus Bounded

### Current

- Direct chat, agent kickoff, and threaded session rendering are implemented.
- The session view uses one root-thread SSE stream and keeps replies on the same page.
- The composer handles uploads, slash commands, memory scope, model selection, and live run control.
- The UI surfaces for skills, playbooks, wiki, artifacts, secrets, review, automations, and settings are real pages.
- Automations refetch their list and open history drawer on create, update, delete, fire, and related run invalidations. The existing 30-second list and 15-second history polls remain recovery fallbacks.
- Document, spreadsheet, presentation, and PDF workpieces edit bounded canonical state and can request native Office/PDF exports. PPTX slide-state and PDF text editing are companion workflows, not rich binary round-trip editors; uploaded PDF import remains unsupported.
- Settings exposes metadata-only API-key and ChatGPT/Codex account lifecycle state. It refetches on mount and received provider-connection invalidations, exposes manual refresh, and polls only while an interactive Codex login is pending. A connected ChatGPT account is not evidence that subscription-backed sandbox execution is enabled.

### Bounded Roadmap

- Canonical timeline rendering is still opt-in.
- Some advanced session capabilities still depend on the current engine adapter and provider.
- Ambient management realtime is single-backend only until the backend adds durable cross-replica fanout.
- The frontend does not own storage or execution. It renders backend state and events.

## See Also

- [`../README.md`](../README.md) for the repo map.
- [`../backend/README.md`](../backend/README.md) for the control plane.
- [`../packages/agent-client/README.md`](../packages/agent-client/README.md) for the thread event client.
- [`../packages/agent-harness/README.md`](../packages/agent-harness/README.md) for the canonical engine contract.
