# UI E2E browser sweep

Aggressive browser-level end-to-end sweep of the skynet-a product UI. Playwright
headless (system Chrome, `channel: "chrome"`) drives the **real** frontend against
a **real** backend + `skynet` DB — no mocking of app code. Only two failure
injections use `page.route` (aborting a `/api/runs` POST) to exercise the
composers' failed-send handling; everything else is genuine.

Every run stamps a provenance line (commit SHA + dirty flag + branch + ISO
timestamp + bun/platform + which scenarios ran) so a result is always bound to
the exact code it exercised.

## What it covers (17 scenarios)

Scenarios 1–11 are the chat/session surface; 12–17 are the route-level product
surfaces. Each 12–17 scenario **seeds its own real fixtures** (tagged `uisweep`)
through the backend, then asserts the page renders that real data — or an honest
empty/error — with zero fabricated strings. `cleanup.ts` deletes every fixture.

1. **Hero composer** — send, duplicate-submit guard, single-POST-on-double-click,
   nav to `/session/{id}`, pickers feed the POST, failed-send error alert + draft
   preserved.
2. **Reply composer** — per-submission `Idempotency-Key`, key **reused** on retry
   of the same text, draft restore + failed alert, recovery on real send.
3. **Slash autocomplete** — `/` popover from a live thread (commands come from the
   sandbox's `GET /api/live-proxy/{id}/command`), prefix filter, Enter **completes**
   `/<cmd> ` and does **not** submit.
4. **Live streaming** — progressive markdown narration, LoadingState pixel-grid
   visible while live then replaced by the settled answer, no prompt echo
   (sentinel appears once), paragraphs separated.
5. **Fanout UI** — 3 subagent cards (ALPHA/BETA/GAMMA), drill-in isolation (each
   detail shows only its own write), back nav, no duplicate rows (SSE+poller
   collapsed), settled worklog collapses with a step count.
6. **Reconnect** — reload mid-run resumes; after settle the rendered cards/steps
   match API truth (no missing / duplicated).
7. **Terminal pane** — Shell|Log tabs sized right (≤14px), Log renders the run's
   shell commands, Shell mounts the ghostty canvas, PTY echo roundtrip over the
   WebSocket (both the app's proxied `location.host` path and the backend direct).
8. **Desktop tab** — present for opencode threads, noVNC iframe, `vnc.html` 200.
9. **Auth surfaces** — `/login` (Google disabled + honest hint, email form,
   Sign in), `/api/config` honesty, `ALLOW_DEV_ORG` keeps the API working
   unauthenticated, anonymous user-menu shows "Sign in" not "Log out".
10. **Rail dragger** — drag the separator resizes the rail + persists to
    `localStorage["skynet.rail-width"]`, restored on reload.
11. **Session a11y smoke** — no uncaught JS / console errors and no 404 resource
    requests on load + stream.
12. **Skills** — seeds a real skill (`POST /api/skills`), asserts the library
    card + its detail sections render, then the card's **Run** button deep-links
    to `/agent/new?skill=<id>` with the playbook **preselected** in the composer.
13. **Knowledge** — seeds a real record (`POST /api/knowledge/ingest`), asserts
    it renders (found by its unique token), and the **Add** modal exposes real
    name/content fields with no fabricated "saved" claim before submit.
14. **Wiki** — asserts the honest empty branch iff zero published docs, then
    creates + publishes a real document and asserts its **title + body** render.
15. **Schedules** — creates a schedule through the **New schedule** modal, asserts
    the new row lands in the list with its cron + **Disabled** status (created
    off), and that it persisted server-side `enabled=false`.
16. **Workspace** — the **Limits** card reflects real `/api/fleet` (per-model
    burn + `tokens today`, or the honest "No model runs yet today."), and fleet
    run rows link to **`/session/{id}`** (a real run id; never the dead
    `/agent/runs/`).
17. **Live Artifacts** (`/agent/artifacts`, the real one — `/artifacts` is a
    placeholder gallery, not tested) — each card links to `/session/{runId}` for
    a real run, or the honest "No artifacts yet" empty state with the Start-a-run
    CTA.

## Running it

Requires an **isolated stack** (never touch shared dev servers):

```bash
# backend on :3513 against the real `skynet` DB, memory disabled to avoid
# polluting shared team memory:
cd backend && PORT=3513 MEMORY_API_URL="" FRONTEND_ORIGIN="http://localhost:3200" bun src/index.ts

# frontend on :3413 proxying /api to :3513:
cd frontend && USEAGENT_API_ORIGIN="http://localhost:3513" ./node_modules/.bin/next dev -p 3413

# playwright-core (system Chrome) is a declared backend devDependency, so
# `cd backend && bun install` restores it (bun resolves node_modules upward from
# the script's directory). It lives OUTSIDE the app tsc `include`, so its
# playwright-core import never breaks `bun run typecheck`.
cd backend && bun install

# run the sweep (all scenarios), or filter:
FE_ORIGIN=http://localhost:3413 BE_ORIGIN=http://localhost:3513 bun backend/test/e2e/ui-sweep/sweep.ts
SCENARIOS=1,4,8 bun backend/test/e2e/ui-sweep/sweep.ts
WF_RID=<warm-opencode-run-id> bun backend/test/e2e/ui-sweep/sweep.ts   # reuse a warm fanout fixture

# clean up EVERY throwaway fixture it created (only rows tagged 'uisweep' —
# runs, skills, schedules, knowledge records + wiki documents):
DATABASE_URL=postgres://postgres@localhost:5432/skynet bun backend/test/e2e/ui-sweep/cleanup.ts
```

Real opencode fixtures use `model: claude-haiku-4-5` (cheap/fast). Every fixture
carries the `uisweep` tag (run prompt, skill/schedule name, knowledge
external_id, document title) so `cleanup.ts` deletes only this suite's rows.
Results are written to `/tmp/uisweep-results.json`; failure screenshots to
`$UISWEEP_SHOTS` (default `/tmp/uisweep-shots/`).
