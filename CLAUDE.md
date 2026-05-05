# skynet — CLAUDE.md

Skynet, rebuilt. Two standalone apps (no workspace/turbo):

- `frontend/` — Next 16 + React 19 + AlignUI (vendored) product UI. Conventions live in
  `frontend/AGENTS.md` and `frontend/components/foundations/DESIGN-RAMP.md` — READ THEM
  before touching UI. `/api/*` is a Next rewrite to the backend (:3201).
- `backend/` — Bun + Hono + Postgres/Drizzle **VERA** backend: event-sourced runs/steps
  (Postgres is the source of truth), replaceable engine adapters (`src/engines/`) spawned
  one-shot per run, worker + SSE, better-auth org scoping. The harness lives OUTSIDE the
  sandbox; the UI renders the event log, never a live process.

**Read `HANDOFF.md` first** — it records the settled decisions (do not re-litigate: no
engine-UI iframes, no harness-in-sandbox, threading is backend truth) and the working
protocol. Architecture source of truth: `~/Documents/skynet-saas/ARCHITECTURE.md`.

## Hard rules
- Runtime is **bun** everywhere. Never npm (broken root-owned cache on this machine).
- **NEVER run `psql`** — it hangs on a Postgres.app permission dialog. Use bun `postgres`
  client scripts for any DB work.
- Dev servers :3200/:3201/:3300/:3400 are usually running and may be owned by OTHER agent
  sessions — check `lsof -i :<port>` before starting anything; never restart servers you
  don't own. Verify on alternate ports (:3401/:3501 pattern).
- Team memory (TencentDB-Agent-Memory) is config-gated via `MEMORY_API_URL` — unset means
  no-op; a memory failure must never fail a run. Bring-up docs in `memory/`.
- `bun run typecheck` (root) must pass before reporting done. Tests: `cd backend && bun run
  test` (isolated `skynet_test` db).
- The pre-rebuild monorepo (Daytona sandboxes, OpenCode iframes, Slack control-plane) lives
  in git history before branch `rebuild/skynet-a` — reference only, do not resurrect.
- `frontend/components/ai/approval-card.tsx` is kept-but-unused on purpose (engines are
  one-shot yolo; no real approval flow yet). Don't delete it and don't render it as demo
  furniture — wire it only when a genuine backend approval flow exists.
- Keep the progress folders updated as work lands: `frontend/progress/YYYY-MM/YYYY-MM-DD.md`
  and `backend/progress/YYYY-MM/YYYY-MM-DD.md` (+ INDEX.md links) — small, factual entries.
