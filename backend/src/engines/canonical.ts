/**
 * Compatibility facade. The canonical event vocabulary moved to the shared,
 * zero-dependency `@useagent/agent-harness` package so both the backend and a
 * future independent consumer can depend on it without importing product code.
 *
 * This file is intentionally a pure re-export so every existing
 * `./canonical` / `../engines/canonical` import keeps working unchanged. Do not
 * add logic here; edit the package source instead. Remove this facade only after
 * all callers import the package directly and the rollback window has passed.
 */
export * from "@useagent/agent-harness/canonical";
