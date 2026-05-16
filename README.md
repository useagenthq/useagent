# skynet

Skynet, rebuilt. Two standalone apps at the repo root — no monorepo, no workspaces.

- **`frontend/`** — the product UI. Next.js 16 + AlignUI Pro (vendored), multi-repo
  session pages, threaded conversations rendered from the backend event log. Dev on
  **:3400**; a Next rewrite proxies `/api/*` → the backend on **:3201**.
- **`backend/`** — the harness. Bun + Hono + Postgres (Drizzle). **VERA**:
  Verify-gated, Event-sourced, Replaceable-engine Actors. Runs/steps are an append-only
  event log in Postgres (the source of truth); replaceable engine adapters
  (`src/engines/`) spawn one rented agent process per run in an isolated workdir
  (`backend/.runs/<id>/`) and translate its stream into `step` events. **The harness
  lives OUTSIDE the sandbox, permanently** — the UI renders the log, never the live
  process. Dev on **:3201**.

## Run it

Each app is standalone with its own lockfile — install per app, then start both:

```bash
# install
cd frontend && bun install
cd ../backend && bun install

# from the repo root — backend first (frontend proxies /api/* → :3201)
bun run dev:backend     # http://localhost:3201
bun run dev:frontend    # http://localhost:3400

# typecheck both
bun run typecheck
```

Backend needs Postgres and its `.env` (see `backend/`); it runs the idempotent boot
migrator on start. Runtime is **bun** everywhere — do not use npm on this machine.

## Where the decisions live

- **`codex-author/HANDOFF.md`** — the full decision log: what the old approach got wrong, the settled
  architecture, per-repo conventions, and coordination rules. Read it first.
- **`new_prompt_modular.md`** — the current no-rewrite harness-library extraction
  contract and end-to-end reusable-stack boundary.
- **`~/Documents/skynet-saas/ARCHITECTURE.md`** — the architecture source of
  truth (VERA rationale, HARNESS-EXPLAINED). Most "obvious" alternatives were already
  evaluated and rejected there for recorded reasons.

## History

The previous monorepo — Daytona per-session sandboxes, OpenCode driven as an iframe, and
a Slack control-plane — lives in git history before branch `rebuild/skynet-a`. It is
superseded; do not resurrect the iframe or the in-sandbox harness.
