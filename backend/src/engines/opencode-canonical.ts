/**
 * Compatibility facade. The OpenCode -> canonical translator moved to the shared
 * `@skynet/agent-harness` package (subpath `./opencode`) so its golden fixtures
 * and tests no longer cross the backend/frontend tree boundary.
 *
 * This file is intentionally a pure re-export so every existing
 * `./opencode-canonical` / `../engines/opencode-canonical` import keeps working
 * unchanged. Do not add logic here; edit the package source instead. Remove this
 * facade only after all callers import the package directly and the rollback
 * window has passed.
 */
export * from "@skynet/agent-harness/opencode";
