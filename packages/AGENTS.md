# packages - agent guide

Shared TypeScript packages. `CLAUDE.md` imports this file; edit here. Root
rules: [../AGENTS.md](../AGENTS.md).

Every package is `private` and ESM, and apps import its TypeScript source
directly (no build step); `runner` and `cli` are binaries instead (`bin`
entries; `cd packages/runner && bun run build` builds the runner's). Each has
`bun run typecheck` and `bun run test`; CI runs both for all 13 (`package-test`
in `.github/workflows/ci.yml`), and the root typecheck covers them too.

| Package | What it is | Imported by |
|---|---|---|
| `agent-client` | the wire contract (`@useagent/agent-client/wire`, `ENGINE_IDS`), API client, reconnecting thread store and selectors | frontend, backend, cli, conformance |
| `agent-harness` | native engine events (OpenCode, Claude Code, Codex, Pi) to one canonical vocabulary, plus the control seam | backend, frontend, agent-client |
| `artifact-workspace` | browser-safe artifact MIME constants and workpiece helpers | frontend, backend, agent-client, artifact-formats |
| `artifact-formats` | DOCX, XLSX, PPTX and PDF rendering and bounded text extraction | backend |
| `sandbox-contract` | the provider-neutral sandbox contract (types) and its shared conformance suite (`@useagent/sandbox-contract/conformance`) | backend, every plugin |
| `sandbox-daytona`, `sandbox-cube`, `sandbox-box`, `sandbox-local` | one plugin per sandbox vendor; each owns its client, env config, credential check, preview auth and workspace layout | `backend/src/sandboxes/plugins.ts` |
| `runner-protocol` | the runner-to-plane wire: one outbound WebSocket split into RPC calls and byte streams | backend, runner, sandbox-local |
| `runner` | the per-machine runner that lends a developer's machine as a sandbox provider (built into binaries) | the desktop app bundles its binary |
| `cli` | the `useagent` CLI and its MCP server | nothing; a `bin` entry, not published yet |
| `conformance` | per-engine conformance harness and evidence tools | nothing; it runs on its own (the acceptance suite for providers) |

## Rules, most violated first

- A changed package is not seen by the apps until they reinstall: bun copies
  `file:` dependencies into `node_modules`. After editing a package, run
  `bun install --frozen-lockfile` in every app that links it (`frontend/`,
  `backend/`) before typecheck or tests, or they test the old copy.
- Packages never import an app (`backend/`, `frontend/`, `@/`). The boundary
  tests hold this and more; never widen an allowlist to land a change:
  `sandbox-contract/test/import-boundary.test.ts` (a pure leaf: relative imports
  only, no runtime or vendor SDK), `agent-harness/test/import-boundary.test.ts`
  (relative imports only), `agent-client/test/import-boundary.test.ts` (a short
  allowlist of package imports, and the package must build for the browser),
  `cli/test/import-boundary.test.ts` (agent-client only),
  `artifact-workspace/test/boundary.test.ts` (no dependencies, no `node:`).
- A sandbox vendor is one package plus one line in `SANDBOX_PLUGINS` and its kind
  in the `SandboxProviderKind` union; nothing else in the backend may switch on a
  vendor name. Run the shared conformance suite (`sandboxProviderConformance`) in
  the plugin's tests.
- The engine list is `ENGINE_IDS` in `agent-client/src/wire.ts`, the one source
  for the backend schema and the frontend picker. `daytona` and `claude-sdk` are
  legacy aliases kept so old rows resolve; never reuse them for anything new.
- Changing the wire contract: the deployed web client may be older than the
  backend during a release, so keep decoding what the released client reads.
- A deadline signal shared by several waits must not be `AbortSignal.timeout`:
  Bun 1.3.14 drops its timer once the first wait lets go, so it never fires
  again. Use an `AbortController` aborted by its own timer.

## Run and test

```sh
cd packages/<name> && bun install --frozen-lockfile && bun run typecheck && bun run test
```

Install every package once in a fresh clone (`for p in packages/*/; do (cd "$p" && bun install --frozen-lockfile); done`):
a missing-module error in a new checkout is a missing install, not a bug.

## Before you say done

1. The package's own typecheck and tests, plus the root `bun run typecheck`.
2. Apps reinstalled if they link the package, and their tests run against it.
3. Boundary tests untouched or tightened, never widened.

## Review prompt

```
Review exactly the pull request's diff in packages/. Check: no package imports an app;
boundary-test allowlists unchanged or narrower; wire changes stay decodable by the
released client; a sandbox vendor added only as a plugin plus SANDBOX_PLUGINS;
ENGINE_IDS legacy aliases untouched. P1 = broken consumer, widened boundary, wire break.
End with VERDICT: APPROVE or VERDICT: CHANGES.
```
