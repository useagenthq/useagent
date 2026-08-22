/**
 * @skynet/agent-client - the browser/runtime-neutral Skynet thread client.
 *
 * Understands ONLY the Skynet product API + canonical/thread events. It knows nothing
 * about OpenCode, ACP, Claude, Codex, Daytona, secrets, or databases, and imports no
 * React, Next, Node-only, backend, or provider module. Its only bare imports are the
 * zero-dependency canonical protocol and artifact-workspace contracts. A UI supplies
 * fetch, EventSource, timers, base URL, and auth headers; the library owns the typed API,
 * the reconnect / replay connection, the canonical reducer, and selectors.
 *
 * Subpath entry points (see package.json exports):
 *   - `@skynet/agent-client/api`        - typed AgentClient over injected fetch
 *   - `@skynet/agent-client/org-changes` - canonical org invalidation wire contract
 *   - `@skynet/agent-client/integrations` - browser-safe integration wire contracts
 *   - `@skynet/agent-client/provider-connections` - provider API + realtime wire contract
 *   - `@skynet/agent-client/connection` - the pure SSE reconnect/health/fallback machine
 *   - `@skynet/agent-client/store`      - the pure canonical thread store
 */
export * from "./api";
export * from "./artifacts";
export * from "./connection";
export * from "./integrations";
export * from "./org-changes";
export * from "./provider-connections";
export * from "./thread-events";
export * from "./thread-store";
export * from "./selectors";
