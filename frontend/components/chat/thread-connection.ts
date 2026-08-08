/**
 * Compatibility facade. The pure SSE connection controller moved to the
 * runtime-neutral `@skynet/agent-client` package (subpath `./connection`). This
 * re-export keeps every existing `./thread-connection` import working unchanged.
 * Do not add logic here; edit the package source instead. Remove this facade only
 * after all callers import the package directly and the rollback window has passed.
 */
export * from "@skynet/agent-client/connection";
