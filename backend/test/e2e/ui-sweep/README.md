# UI E2E browser sweep

Aggressive browser-level end-to-end sweep of the skynet-a product UI. Playwright
headless (system Chrome, `channel: "chrome"`) drives the **real** frontend against
a **real** backend + `skynet` DB — no mocking of app code. Only two failure
injections use `page.route` (aborting a `/api/runs` POST) to exercise the
composers' failed-send handling; everything else is genuine.

## What it covers (11 scenarios, mapped to the 10 asks)

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

## Running it

Requires an **isolated stack** (never touch shared dev servers):

```bash
# backend on :3513 against the real `skynet` DB, memory disabled to avoid
# polluting shared team memory:
cd backend && PORT=3513 MEMORY_API_URL="" FRONTEND_ORIGIN="http://localhost:3200" bun src/index.ts

# frontend on :3413 proxying /api to :3513:
cd frontend && SKYNET_API_ORIGIN="http://localhost:3513" ./node_modules/.bin/next dev -p 3413

# playwright-core (system Chrome) is the only extra dep — it must be resolvable
# from wherever you run the script. It lives here (backend/test/e2e/ui-sweep/,
# OUTSIDE the app tsc `include`, so its playwright-core import never breaks
# `bun run typecheck`). Install it once, e.g. in the frontend worktree, and run
# with bun (bun resolves node_modules upward from the script's directory):
cd backend && bun add -d playwright-core   # or reuse a frontend install

# run the sweep (all scenarios), or filter:
FE_ORIGIN=http://localhost:3413 BE_ORIGIN=http://localhost:3513 bun backend/test/e2e/ui-sweep/sweep.ts
SCENARIOS=1,4,8 bun backend/test/e2e/ui-sweep/sweep.ts
WF_RID=<warm-opencode-run-id> bun backend/test/e2e/ui-sweep/sweep.ts   # reuse a warm fanout fixture

# clean up the throwaway runs it created (only rows tagged 'uisweep'):
DATABASE_URL=postgres://postgres@localhost:5432/skynet bun backend/test/e2e/ui-sweep/cleanup.ts
```

Real opencode fixtures use `model: claude-haiku-4-5` (cheap/fast). Every fixture
prompt carries the `uisweep` tag so `cleanup.ts` deletes only this suite's rows.
Results are written to `/tmp/uisweep-results.json`; failure screenshots to
`$UISWEEP_SHOTS` (default `/tmp/uisweep-shots/`).
