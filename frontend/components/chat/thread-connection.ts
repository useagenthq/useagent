/**
 * Compatibility facade. The pure SSE connection controller lives in the
 * runtime-neutral `@useagent/agent-client` package - the SINGLE implementation. This
 * re-export keeps every existing `./thread-connection` import working unchanged.
 * Do not add logic here; edit the package source instead.
 */
export * from "@useagent/agent-client";
