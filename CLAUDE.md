# skynet — CLAUDE.md

Skynet, rebuilt. Two standalone apps (no workspace/turbo):

- `frontend/` — Next 16 + React 19 + AlignUI (vendored) product UI. Conventions live in
  `frontend/AGENTS.md` and `frontend/components/foundations/DESIGN-RAMP.md` — READ THEM
  before touching UI. `/api/*` is a Next rewrite to the backend (:3201).
- `backend/` — Bun + Hono + Postgres/Drizzle **VERA** backend: event-sourced runs/steps
  (Postgres is the source of truth), replaceable engine adapters (`src/engines/`) spawned
  one-shot per run, worker + SSE, better-auth org scoping. The harness lives OUTSIDE the
  sandbox; the UI renders the event log, never a live process.

**Settled decisions (do not re-litigate):** no engine-UI iframes, no harness-in-sandbox,
threading is backend truth. Architecture source of truth:
`~/Documents/skynet-saas/ARCHITECTURE.md`. The doctrine docs cited by code
comments (`mem_op.md`, `final_fix.md`, `new_mem_prompt.md`) live in `docs/architecture/`.

## Branches (2026-08-05 decisions)
- `rebuild/skynet-a` (main line): NATIVE React chat is the primary surface — we
  own the rendering layer so the extension surface (artifact/PPT/PDF viewers,
  custom panes) stays ours (reference bot / Cloudflare-OS model). Terminal (ghostty
  shell), Desktop/VNC pane, Agents rail and ALL backend engine/proxy machinery
  live here.
- `feat/opencode-live-embed`: the complete working opencode inline-embed
  (solid-element `<skynet-oc-session>`, seamless theme, allowlist WIP) —
  preserved for reference/revival.
- `feat/react-session-port` (worktree ../skynet-react-port): React-native port
  of opencode's session UI — forward path for chat quality. Handoff doc:
  react_port.md.

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

## Test + ops arsenal (2026-08-06 night program)
- `cd backend && bun run e2e` (mock full-stack, ~fast) · `bun run e2e:real` (9-stage real
  Daytona/opencode/memory suite, ~2min, self-cleaning) · `bun run soak` (storm marathon)
  · ui sweep: `bun backend/test/e2e/ui-sweep/sweep.ts`.
- Daytona hygiene: ALWAYS delete + API-verify sandboxes after tests;
  orphan sweep: `bun backend/test/e2e/soak/lib/daytona.ts sweep-orphans`.
- Drizzle migration trap: the boot migrator applies only entries with journal `when`
  GREATER than the last applied — always stamp strictly above the journal tail
  (hand-set future stamps have silently skipped later migrations twice).
- The real dev DB is `skynet` (backend/.env), NOT `skynet_rebuild` (stale docs name).

- No em dashes ("—") in code-level user-visible strings (labels, placeholders, summaries, aria); use hyphens or rephrase.

- Never boot a second backend against the shared `skynet` DB: boot recovery (recoverStaleRuns) will reconcile/fail OTHER sessions in-flight runs. Tests use throwaway DBs.

- SINGLE-BACKEND DEPLOYMENT (this release): the canonical lane's provider-source seal (`drainProviderEvents`) and the realtime SSE fan-out (thread-signals + canonical-events EventEmitters) are PROCESS-LOCAL; `FOR UPDATE SKIP LOCKED` only protects canonicalization CLAIMING, not sealing/fan-out. Exactly ONE backend per database is supported. Boot acquires a per-database Postgres advisory lock (`src/db/single-backend.ts`); a duplicate warns by default and REFUSES to boot when `REQUIRE_SINGLE_BACKEND=1`. Production MUST set `REQUIRE_SINGLE_BACKEND=1` and run one replica. Multi-replica realtime needs a durable DB-backed seal first (do not claim multi-replica safety without it).

- NAMING: name code by FUNCTION, attribute by HEADER. Third-party product names
  (t3, beui, etc.) never appear in our identifiers, component names, directories,
  or data attributes EXCEPT at a true protocol boundary (code that speaks that
  product's actual wire protocol, e.g. backend `t3-provider-driver`
  and the `opencode-t3` frame parsers). Vendored code keeps its MIT/source
  attribution in the file header, not in the symbol names. Frontend vendored UI
  lives in `components/session-ui/` with neutral names.
