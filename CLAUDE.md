# useAgent - CLAUDE.md

Guidance for coding agents working in this repository. Two standalone apps plus
shared packages (no workspace/turbo; every package installs independently).

- `frontend/` - Next.js + React product UI on the BoardUI design system.
  Conventions live in `frontend/AGENTS.md` and
  `frontend/components/foundations/DESIGN-RAMP.md` - read them before touching
  UI. `/api/*` is a Next rewrite to the backend.
- `backend/` - Bun + Hono + Postgres/Drizzle control plane: event-sourced
  runs/steps (Postgres is the source of truth), replaceable engine adapters
  (`src/engines/`) spawned one-shot per run, worker + SSE, better-auth org
  scoping. The trusted control plane and adapter boundary stay outside the
  sandbox; the UI renders the event log, never a live process.
- `packages/` - shared TypeScript contracts (`agent-client` wire types,
  `agent-harness` canonical translation, `artifact-workspace`,
  `artifact-formats`, `sandbox-contract`). Packages never import apps.

Architecture references: `README.md`, `backend/README.md`, `frontend/README.md`,
`docs/architecture/`, and the docs site in `docs-site/`.

## Hard rules

- Runtime is **bun** everywhere; never npm.
- `bun run typecheck` (root) must pass before reporting done. Tests:
  `cd backend && bun run test` (isolated test database) and
  `cd frontend && bun test components`.
- Settled decisions - do not re-litigate: no engine-UI iframes; the trusted
  control plane stays outside the sandbox; threading is backend truth.
- Drizzle migration trap: the boot migrator applies only entries with journal
  `when` GREATER than the last applied - always stamp strictly above the
  journal tail.
- SINGLE-BACKEND DEPLOYMENT: exactly one backend per database is supported
  (process-local canonical sealing + SSE fan-out). Production must set
  `REQUIRE_SINGLE_BACKEND=1` and run one replica.
- NAMING: name code by FUNCTION, attribute by HEADER. Third-party product
  names never appear in our identifiers, components, directories, or data
  attributes EXCEPT at a true protocol boundary (code speaking that product's
  wire protocol). Vendored code keeps its attribution in the file header, not
  in symbol names.
- No em dashes in code-level user-visible strings (labels, placeholders,
  summaries, aria); use hyphens or rephrase.
- Never boot a second backend against a shared database: boot recovery
  reconciles other processes' in-flight runs. Tests use throwaway databases.

Machine- or operator-specific notes belong in `CLAUDE.local.md` (gitignored),
never in this file.
