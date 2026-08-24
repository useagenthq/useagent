/**
 * @useagent/agent-client - the browser/runtime-neutral Skynet thread client.
 *
 * Understands ONLY the Skynet product API + canonical/thread events. It knows nothing
 * about OpenCode, ACP, Claude, Codex, Daytona, secrets, or databases, and imports no
 * React, Next, Node-only, backend, or provider module. Its only bare imports are the
 * zero-dependency canonical protocol and artifact-workspace contracts. A UI supplies
 * fetch, EventSource, timers, base URL, and auth headers; the library owns the typed API,
 * the reconnect / replay connection, the canonical reducer, and selectors.
 *
 * Subpath entry points (see package.json exports):
 *   - `@useagent/agent-client/wire`       - the run/step/native wire contract (ground truth)
 *   - `@useagent/agent-client/api`        - typed AgentClient over injected fetch
 *   - `@useagent/agent-client/fleet`      - authenticated parallel cloud dispatch + QC
 *   - `@useagent/agent-client/org-changes` - canonical org invalidation wire contract
 *   - `@useagent/agent-client/integrations` - browser-safe integration wire contracts
 *   - `@useagent/agent-client/provider-connections` - provider API + realtime wire contract
 *   - `@useagent/agent-client/connection` - the pure SSE reconnect/health/fallback machine
 *   - `@useagent/agent-client/store`      - the pure canonical thread store
 */
export * from "./wire";
export * from "./api";
export * from "./fleet";
export * from "./artifacts";
export * from "./connection";
export * from "./integrations";
export * from "./org-changes";
export * from "./provider-connections";
export * from "./thread-events";
export * from "./thread-store";
export * from "./selectors";
